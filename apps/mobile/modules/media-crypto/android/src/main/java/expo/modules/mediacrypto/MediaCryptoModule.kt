package expo.modules.mediacrypto

import android.media.ExifInterface
import android.net.Uri
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.signal.libsignal.crypto.Aes256GcmDecryption
import org.signal.libsignal.crypto.Aes256GcmEncryption
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.security.SecureRandom

private const val KEY_BYTES = 32
private const val NONCE_BYTES = 12
private const val TAG_BYTES = 16
private const val MIN_PADDED_BYTES = 1024L
private const val MAX_PLAINTEXT_BYTES = 100L * 1024 * 1024
private const val CHUNK = 64 * 1024

/** Associated data: binds every blob to this format and version. */
private val AAD = "SecureChat attachment v1".toByteArray(Charsets.US_ASCII)

private val GPS_TAGS = arrayOf(
  ExifInterface.TAG_GPS_LATITUDE,
  ExifInterface.TAG_GPS_LATITUDE_REF,
  ExifInterface.TAG_GPS_LONGITUDE,
  ExifInterface.TAG_GPS_LONGITUDE_REF,
  ExifInterface.TAG_GPS_ALTITUDE,
  ExifInterface.TAG_GPS_ALTITUDE_REF,
  ExifInterface.TAG_GPS_TIMESTAMP,
  ExifInterface.TAG_GPS_DATESTAMP,
  ExifInterface.TAG_GPS_PROCESSING_METHOD,
  ExifInterface.TAG_GPS_AREA_INFORMATION,
  ExifInterface.TAG_GPS_SPEED,
  ExifInterface.TAG_GPS_SPEED_REF,
  ExifInterface.TAG_GPS_IMG_DIRECTION,
  ExifInterface.TAG_GPS_IMG_DIRECTION_REF,
  ExifInterface.TAG_GPS_DEST_LATITUDE,
  ExifInterface.TAG_GPS_DEST_LONGITUDE,
)

class MediaIntegrityException :
  CodedException("ERR_MEDIA_INTEGRITY", "The encrypted file is damaged or was altered", null)

class MediaPathException :
  CodedException("ERR_MEDIA_PATH", "Only files inside the app's private storage can be used", null)

class MediaSizeException(message: String) : CodedException("ERR_MEDIA_SIZE", message, null)

/**
 * Attachment encryption for files, streamed so that a large video never has to fit in memory
 * and plaintext never crosses into JavaScript.
 *
 * No cryptography is implemented here: AES-256-GCM is libsignal's incremental implementation
 * (org.signal.libsignal.crypto, the same audited library as the Signal Protocol bridge), SHA-256
 * and the key/nonce CSPRNG are the platform's.
 *
 *   blob   = nonce (12) || AES-256-GCM(key, nonce, aad, plaintext || zero padding) || tag (16)
 *   digest = SHA-256(blob)  (travels with the key in the Signal message)
 *
 * Every path must be inside the app's own files or cache directory: this module can never read
 * from or write to shared storage (Pictures, DCIM, Downloads, ...).
 */
class MediaCryptoModule : Module() {
  private val random = SecureRandom()

  override fun definition() = ModuleDefinition {
    Name("MediaCrypto")

    /**
     * Encrypts `sourceUri` into a new blob at `destUri`. With `stripLocation`, GPS tags are first
     * removed from the (private, temporary) JPEG copy. On any failure nothing is left at destUri.
     */
    AsyncFunction("encryptFile") { sourceUri: String, destUri: String, stripLocation: Boolean ->
      val source = privateFile(sourceUri)
      val dest = privateFile(destUri)
      if (!source.isFile) throw MediaSizeException("The file to send does not exist")
      if (stripLocation) stripGpsTags(source)
      val size = source.length()
      if (size <= 0 || size > MAX_PLAINTEXT_BYTES) throw MediaSizeException("Unsupported file size")
      val padded = paddedSize(size)
      val key = ByteArray(KEY_BYTES).also { random.nextBytes(it) }
      val nonce = ByteArray(NONCE_BYTES).also { random.nextBytes(it) }
      val sha = MessageDigest.getInstance("SHA-256")

      try {
        dest.parentFile?.mkdirs()
        FileInputStream(source).use { input ->
          FileOutputStream(dest).use { output ->
            val cipher = Aes256GcmEncryption(key, nonce, AAD)
            output.write(nonce)
            sha.update(nonce)
            val buffer = ByteArray(CHUNK)
            val emit = { n: Int ->
              cipher.encrypt(buffer, 0, n) // in place
              output.write(buffer, 0, n)
              sha.update(buffer, 0, n)
            }
            var plaintextLeft = size
            while (plaintextLeft > 0) {
              val n = readFully(input, buffer, minOf(CHUNK.toLong(), plaintextLeft).toInt())
              if (n <= 0) throw MediaSizeException("The file changed while it was encrypted")
              emit(n)
              plaintextLeft -= n
            }
            var paddingLeft = padded - size
            while (paddingLeft > 0) {
              val n = minOf(CHUNK.toLong(), paddingLeft).toInt()
              buffer.fill(0, 0, n)
              emit(n)
              paddingLeft -= n
            }
            val tag = cipher.computeTag()
            output.write(tag)
            sha.update(tag)
            output.fd.sync()
          }
        }
      } catch (e: Throwable) {
        dest.delete()
        throw e
      }
      mapOf(
        "key" to b64(key),
        "digest" to b64(sha.digest()),
        "size" to size.toDouble(),
        "encryptedSize" to (NONCE_BYTES + padded + TAG_BYTES).toDouble(),
      )
    }

    /** Checks a blob against its size, digest and GCM tag without writing any plaintext. */
    AsyncFunction("verifyFile") { uri: String, key: String, digest: String, size: Double ->
      process(privateFile(uri), unb64(key), unb64(digest), size.toLong(), null)
      true
    }

    /**
     * Decrypts a blob into `destUri` (a temporary file for viewing), writing exactly `size`
     * bytes. The size, digest and tag are verified; if anything fails, destUri is deleted.
     */
    AsyncFunction("decryptFile") { uri: String, key: String, digest: String, size: Double, destUri: String ->
      val dest = privateFile(destUri)
      dest.parentFile?.mkdirs()
      try {
        FileOutputStream(dest).use { output ->
          process(privateFile(uri), unb64(key), unb64(digest), size.toLong(), output)
        }
      } catch (e: Throwable) {
        dest.delete()
        throw e
      }
      true
    }
  }

  /** One pass over a blob: digest + GCM decryption; plaintext (unpadded) to `output` if given. */
  private fun process(blob: File, key: ByteArray, digest: ByteArray, size: Long, output: FileOutputStream?) {
    if (key.size != KEY_BYTES || size < 0 || size > MAX_PLAINTEXT_BYTES) throw MediaIntegrityException()
    val padded = paddedSize(size)
    if (!blob.isFile || blob.length() != NONCE_BYTES + padded + TAG_BYTES) throw MediaIntegrityException()
    val sha = MessageDigest.getInstance("SHA-256")
    FileInputStream(blob).use { input ->
      val nonce = ByteArray(NONCE_BYTES)
      if (readFully(input, nonce, NONCE_BYTES) != NONCE_BYTES) throw MediaIntegrityException()
      sha.update(nonce)
      val cipher = Aes256GcmDecryption(key, nonce, AAD)
      val buffer = ByteArray(CHUNK)
      var done = 0L
      while (done < padded) {
        val n = readFully(input, buffer, minOf(CHUNK.toLong(), padded - done).toInt())
        if (n <= 0) throw MediaIntegrityException()
        sha.update(buffer, 0, n)
        cipher.decrypt(buffer, 0, n)
        if (output != null && done < size) output.write(buffer, 0, minOf(n.toLong(), size - done).toInt())
        done += n
      }
      val tag = ByteArray(TAG_BYTES)
      if (readFully(input, tag, TAG_BYTES) != TAG_BYTES) throw MediaIntegrityException()
      sha.update(tag)
      val digestOk = MessageDigest.isEqual(sha.digest(), digest)
      val tagOk = cipher.verifyTag(tag)
      if (!digestOk || !tagOk) throw MediaIntegrityException()
    }
    output?.fd?.sync()
  }

  /** 16 buckets per power of two, at least MIN_PADDED_BYTES (same as paddedAttachmentSize in JS). */
  private fun paddedSize(size: Long): Long {
    if (size <= MIN_PADDED_BYTES) return MIN_PADDED_BYTES
    val exponent = 63 - java.lang.Long.numberOfLeadingZeros(size)
    val step = 1L shl (exponent - 4)
    return ((size + step - 1) / step) * step
  }

  /** Removes location from a JPEG's EXIF data, in place (only ever on the app's own copy). */
  private fun stripGpsTags(file: File) {
    val exif = try {
      ExifInterface(file.absolutePath)
    } catch (e: Exception) {
      return // not a format with EXIF data
    }
    if (GPS_TAGS.none { exif.getAttribute(it) != null }) return
    GPS_TAGS.forEach { exif.setAttribute(it, null) }
    exif.saveAttributes() // throws: the photo is not sent with its location
  }

  /** A file:// URI or absolute path, resolved, that must lie in the app's files or cache dir. */
  private fun privateFile(uri: String): File {
    val context = appContext.reactContext ?: throw MediaPathException()
    val path = if (uri.startsWith("file:")) Uri.parse(uri).path else uri
    if (path.isNullOrEmpty()) throw MediaPathException()
    val file = File(path).canonicalFile
    val roots = listOf(context.filesDir, context.cacheDir).map { it.canonicalPath + File.separator }
    if (roots.none { file.path.startsWith(it) }) throw MediaPathException()
    return file
  }

  private fun readFully(input: InputStream, buffer: ByteArray, length: Int): Int {
    var total = 0
    while (total < length) {
      val n = input.read(buffer, total, length - total)
      if (n < 0) break
      total += n
    }
    return total
  }

  private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
  private fun unb64(value: String): ByteArray = Base64.decode(value, Base64.NO_WRAP)
}

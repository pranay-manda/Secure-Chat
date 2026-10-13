package expo.modules.callservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Foreground service of type "microphone" that runs while a voice call holds the microphone.
 *
 * Since Android 11 a backgrounded app keeps microphone access only through such a service;
 * without it the other person hears silence as soon as the user leaves the app or locks the
 * screen. The service does nothing else: audio is captured and sent by WebRTC, never here.
 *
 * It is started with startService() while the app is in the foreground (the user just placed or
 * answered a call) and promoted with startForeground(), so a refused promotion simply stops the
 * service instead of crashing the app. Its notification says only that a call is in progress:
 * no name, since Chat Lock may hide who is calling.
 */
class CallForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      val notification = buildNotification()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // Not allowed right now (app already in the background, or the microphone permission was
      // revoked). The call still works while the app is open.
      stopSelf()
    }
    // A killed call cannot be resumed, so the service is never restarted by the system.
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // The app was swiped away: its call (and the WebRTC connection) went with it.
    stopSelf()
  }

  override fun onDestroy() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    super.onDestroy()
  }

  private fun buildNotification(): Notification {
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ensureChannel()
        Notification.Builder(this, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
      }
    builder
      .setSmallIcon(smallIcon())
      .setContentTitle("CipherChat")
      .setContentText("Voice call in progress")
      .setCategory(Notification.CATEGORY_CALL)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setOngoing(true)
      .setShowWhen(false)
    openAppIntent()?.let { builder.setContentIntent(it) }
    val color = resources.getIdentifier("notification_icon_color", "color", packageName)
    if (color != 0) builder.setColor(getColor(color))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    return builder.build()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, "Ongoing calls", NotificationManager.IMPORTANCE_LOW)
    channel.description = "Shown while a voice call is in progress"
    channel.setShowBadge(false)
    channel.setSound(null, null)
    manager.createNotificationChannel(channel)
  }

  /** The monochrome icon expo-notifications generates, or the app icon as a fallback. */
  private fun smallIcon(): Int {
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName)
    return if (icon != 0) icon else applicationInfo.icon
  }

  /** Tapping the notification brings the app (and its call screen) back to the front. */
  private fun openAppIntent(): PendingIntent? {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    return PendingIntent.getActivity(
      this,
      0,
      launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  companion object {
    const val CHANNEL_ID = "ongoing_call"
    const val NOTIFICATION_ID = 4201
  }
}

package expo.modules.callservice

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Starts and stops CallForegroundService for the JS call engine. Holds no call data. */
class CallServiceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CallService")

    // Must be called while the app is in the foreground: Android refuses to start services for
    // a backgrounded app (IllegalStateException), which is reported as `false`.
    Function("start") {
      val context = appContext.reactContext ?: return@Function false
      try {
        context.startService(Intent(context, CallForegroundService::class.java))
        true
      } catch (e: Exception) {
        false
      }
    }

    Function("stop") {
      val context = appContext.reactContext ?: return@Function null
      context.stopService(Intent(context, CallForegroundService::class.java))
      null
    }
  }
}

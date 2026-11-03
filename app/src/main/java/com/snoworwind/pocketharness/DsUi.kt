package com.snoworwind.pocketharness

import android.content.Context
import android.database.ContentObserver
import android.content.res.ColorStateList
import android.graphics.drawable.ClipDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.animation.PathInterpolator

/** Shared drawables, motion, and press feedback for the native shell UI. */
internal object DsUi {
  val ease = PathInterpolator(0.32f, 0.72f, 0f, 1f)

  /**
   * 动效总开关（0.13.8 G3-M11，降级统一入口）：系统「关闭动画」三开关任一关闭、
   * 或 ValueAnimator 不活动（省电模式等）→ 所有 overlay 动效直接设终态。
   * 复用 ShimmerTextView.kt 的既有判定口径（单一来源原则）。
   */
  fun animationsEnabled(context: Context): Boolean = animationsEnabledFrom(
    animatorScale = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f),
    transitionScale = Settings.Global.getFloat(context.contentResolver, Settings.Global.TRANSITION_ANIMATION_SCALE, 1f),
    windowScale = Settings.Global.getFloat(context.contentResolver, Settings.Global.WINDOW_ANIMATION_SCALE, 1f),
    animatorsRunning = android.animation.ValueAnimator.areAnimatorsEnabled(),
  )

  internal fun animationsEnabledFrom(
    animatorScale: Float,
    transitionScale: Float,
    windowScale: Float,
    animatorsRunning: Boolean,
  ): Boolean = animatorsRunning && animatorScale != 0f && transitionScale != 0f && windowScale != 0f

  private val motionListeners = mutableListOf<() -> Unit>()
  private var motionObserver: ContentObserver? = null
  private var motionObserverContext: Context? = null
  private val motionSettingKeys = arrayOf(
    Settings.Global.ANIMATOR_DURATION_SCALE,
    Settings.Global.TRANSITION_ANIMATION_SCALE,
    Settings.Global.WINDOW_ANIMATION_SCALE,
  )

  /** Observe system motion-setting changes; callers register and unregister on the main thread. */
  fun registerMotionListener(context: Context, listener: () -> Unit): () -> Unit {
    check(Looper.myLooper() == Looper.getMainLooper()) { "motion listeners must be registered on main thread" }
    val app = context.applicationContext ?: context
    motionListeners += listener
    if (motionObserver == null) {
      val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) = notifyMotionChanged()
      }
      for (key in motionSettingKeys) {
        runCatching { app.contentResolver.registerContentObserver(Settings.Global.getUriFor(key), false, observer) }
      }
      motionObserver = observer
      motionObserverContext = app
    }
    var removed = false
    return {
      if (!removed) {
        removed = true
        motionListeners.remove(listener)
        if (motionListeners.isEmpty()) unregisterMotionObserver()
      }
    }
  }

  internal fun notifyMotionChanged() {
    for (listener in motionListeners.toList()) runCatching { listener() }
  }

  private fun unregisterMotionObserver() {
    val observer = motionObserver ?: return
    runCatching { motionObserverContext?.contentResolver?.unregisterContentObserver(observer) }
    motionObserver = null
    motionObserverContext = null
  }

  internal fun registerMotionListenerForTest(listener: () -> Unit): () -> Unit {
    motionListeners += listener
    var removed = false
    return {
      if (!removed) {
        removed = true
        motionListeners.remove(listener)
      }
    }
  }

  internal fun resetMotionListenersForTest() {
    motionListeners.clear()
    unregisterMotionObserver()
  }

  internal fun motionListenerCountForTest(): Int = motionListeners.size

  fun roundRect(
    color: Int,
    radius: Float,
    strokeColor: Int? = null,
    strokePx: Int = 1,
  ): GradientDrawable = GradientDrawable().apply {
    setColor(color)
    cornerRadius = radius
    if (strokeColor != null) setStroke(strokePx, strokeColor)
  }

  fun oval(color: Int): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.OVAL
    setColor(color)
  }

  fun ripple(fill: GradientDrawable, rippleColor: Int): RippleDrawable {
    val mask = GradientDrawable().apply {
      setColor(0xFFFFFFFF.toInt())
      cornerRadius = fill.cornerRadius
    }
    return RippleDrawable(ColorStateList.valueOf(rippleColor), fill, mask)
  }

  fun progressLayer(trackColor: Int, fillColor: Int, radius: Float): LayerDrawable {
    val track = GradientDrawable().apply {
      setColor(trackColor)
      cornerRadius = radius
    }
    val fill = GradientDrawable().apply {
      setColor(fillColor)
      cornerRadius = radius
    }
    val clip = ClipDrawable(fill, Gravity.START, ClipDrawable.HORIZONTAL)
    return LayerDrawable(arrayOf(track, clip)).apply {
      setId(0, android.R.id.background)
      setId(1, android.R.id.progress)
    }
  }

  fun bindPressScale(view: View, scale: Float = 0.975f) {
    view.setOnTouchListener { v, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN ->
          v.animate().scaleX(scale).scaleY(scale).setDuration(90).setInterpolator(ease).start()
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
          v.animate().scaleX(1f).scaleY(1f).setDuration(160).setInterpolator(ease).start()
      }
      false
    }
  }
}

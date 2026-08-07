package com.rafaypair.android.physiology

import android.content.Context
import androidx.camera.core.CameraControl
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.Executors

/**
 * Finger-camera photoplethysmography capture.
 *
 * Frames never leave the process: each image is reduced to two channel means
 * over a centred region of interest and immediately closed. Nothing is written
 * to disk and nothing is uploaded — only [PulseSample] values escape this class,
 * which is what makes the guarantee auditable at a single boundary.
 *
 * This is an explicit, user-initiated session. There is no continuous stream and
 * no background sampling; the torch is lit only while a measurement runs.
 */
class PulseCaptureController(
    private val context: Context,
    private val onSample: (PulseSample) -> Unit,
) {
    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private var provider: ProcessCameraProvider? = null
    private var cameraControl: CameraControl? = null

    fun start(lifecycleOwner: LifecycleOwner, onFailure: (String) -> Unit) {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            val cameraProvider = runCatching { future.get() }.getOrNull()
            if (cameraProvider == null) {
                onFailure("The camera could not be opened.")
                return@addListener
            }
            provider = cameraProvider

            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(analysisExecutor, ::analyze)

            val camera = runCatching {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    analysis,
                )
            }.getOrNull()
            if (camera == null) {
                onFailure("This device has no rear camera to measure with.")
                return@addListener
            }
            if (!camera.cameraInfo.hasFlashUnit()) {
                // Without a torch the fingertip is unlit and the signal is not
                // recoverable. Saying so beats producing a weak estimate.
                cameraProvider.unbindAll()
                onFailure("This device has no torch, which pulse measurement needs.")
                return@addListener
            }
            cameraControl = camera.cameraControl
            camera.cameraControl.enableTorch(true)
        }, ContextCompat.getMainExecutor(context))
    }

    fun stop() {
        cameraControl?.enableTorch(false)
        cameraControl = null
        provider?.unbindAll()
        provider = null
    }

    fun release() {
        stop()
        analysisExecutor.shutdown()
    }

    private fun analyze(proxy: ImageProxy) {
        try {
            val means = regionMeans(proxy)
            if (means != null) {
                onSample(
                    PulseSample(
                        timestampMs = proxy.imageInfo.timestamp / 1_000_000.0,
                        red = means.first,
                        green = means.second,
                    ),
                )
            }
        } finally {
            // Closing the proxy releases the underlying buffer. Nothing retains
            // it, nothing encodes it, and nothing transmits it.
            proxy.close()
        }
    }

    /**
     * Mean red and green over the centred middle third of the frame.
     *
     * CameraX delivers YUV_420_888. Converting the whole frame to RGB would be
     * wasteful for two numbers, so the conversion is done per sampled pixel from
     * the Y, U and V planes directly.
     */
    private fun regionMeans(proxy: ImageProxy): Pair<Double, Double>? {
        val planes = proxy.planes
        if (planes.size < 3) return null
        val width = proxy.width
        val height = proxy.height
        if (width < 6 || height < 6) return null

        val yBuffer = planes[0].buffer
        val uBuffer = planes[1].buffer
        val vBuffer = planes[2].buffer
        val yRowStride = planes[0].rowStride
        val uvRowStride = planes[1].rowStride
        val uvPixelStride = planes[1].pixelStride

        val startX = width / 3
        val endX = minOf(width, 2 * width / 3)
        val startY = height / 3
        val endY = minOf(height, 2 * height / 3)
        // Sampling every fourth pixel keeps the per-frame cost trivial while
        // still averaging thousands of pixels.
        val step = 4

        var redTotal = 0.0
        var greenTotal = 0.0
        var count = 0

        var y = startY
        while (y < endY) {
            var x = startX
            while (x < endX) {
                val yIndex = y * yRowStride + x
                val uvIndex = (y / 2) * uvRowStride + (x / 2) * uvPixelStride
                if (yIndex >= yBuffer.limit() ||
                    uvIndex >= uBuffer.limit() ||
                    uvIndex >= vBuffer.limit()
                ) {
                    x += step
                    continue
                }
                val luma = (yBuffer.get(yIndex).toInt() and 0xFF).toDouble()
                val chromaU = (uBuffer.get(uvIndex).toInt() and 0xFF) - 128.0
                val chromaV = (vBuffer.get(uvIndex).toInt() and 0xFF) - 128.0

                // BT.601 full-range conversion, matching what the iOS BGRA path
                // receives from the same scene.
                redTotal += clamp255(luma + 1.402 * chromaV)
                greenTotal += clamp255(luma - 0.344136 * chromaU - 0.714136 * chromaV)
                count += 1
                x += step
            }
            y += step
        }
        if (count == 0) return null
        return Pair(redTotal / count, greenTotal / count)
    }

    private fun clamp255(value: Double): Double = when {
        value < 0 -> 0.0
        value > 255 -> 255.0
        else -> value
    }
}

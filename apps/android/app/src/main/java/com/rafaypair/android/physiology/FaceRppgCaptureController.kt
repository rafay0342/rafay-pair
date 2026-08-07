package com.rafaypair.android.physiology

import android.content.Context
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

/**
 * Front-camera capture for the experimental face rPPG mode.
 *
 * Frames never leave the process: each image is reduced to the six numbers the
 * estimator needs over a forehead region and closed. Nothing is written to disk
 * and nothing is uploaded.
 *
 * The camera starts only from an explicit user action inside this mode, which is
 * master specification §3.3's "never silently activate camera" made operational:
 * with [PhysiologyTuning.FACE_RPPG_ENABLED] off, nothing constructs this class.
 */
class FaceRppgCaptureController(
    private val context: Context,
    private val onSample: (FaceRppgSample) -> Unit,
) {
    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private val detector = FaceDetection.getClient(
        FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
            .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_NONE)
            .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_NONE)
            .build(),
    )
    private var provider: ProcessCameraProvider? = null

    fun start(
        lifecycleOwner: LifecycleOwner,
        previewView: PreviewView,
        onFailure: (String) -> Unit,
    ) {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            val cameraProvider = runCatching { future.get() }.getOrNull()
            if (cameraProvider == null) {
                onFailure("The camera could not be opened.")
                return@addListener
            }
            provider = cameraProvider

            val preview = Preview.Builder().build().also {
                it.surfaceProvider = previewView.surfaceProvider
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(analysisExecutor, ::analyze)

            val bound = runCatching {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_FRONT_CAMERA,
                    preview,
                    analysis,
                )
            }.getOrNull()
            if (bound == null) onFailure("This device has no front camera.")
        }, ContextCompat.getMainExecutor(context))
    }

    fun stop() {
        provider?.unbindAll()
        provider = null
    }

    fun release() {
        stop()
        detector.close()
        analysisExecutor.shutdown()
    }

    @androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
    private fun analyze(proxy: ImageProxy) {
        val image = proxy.image
        if (image == null) {
            proxy.close()
            return
        }
        val rotation = proxy.imageInfo.rotationDegrees
        val timestampMs = proxy.imageInfo.timestamp / 1_000_000.0
        val width = if (rotation == 90 || rotation == 270) proxy.height else proxy.width
        val height = if (rotation == 90 || rotation == 270) proxy.width else proxy.height

        detector.process(InputImage.fromMediaImage(image, rotation))
            .addOnSuccessListener { faces ->
                val face = faces.maxByOrNull { it.boundingBox.width() * it.boundingBox.height() }
                if (face == null || width <= 0 || height <= 0) {
                    onSample(FaceRppgSample(timestampMs, 0.0, 0.0, 0.0, 0.5, 0.5))
                    return@addOnSuccessListener
                }
                val box = face.boundingBox
                // The forehead: the best-perfused facial skin least occluded by
                // hair, glasses, and expression.
                val left = box.left + box.width() * 0.25
                val top = box.top + box.height() * 0.08
                val right = left + box.width() * 0.5
                val bottom = top + box.height() * 0.22

                val means = regionMeans(
                    proxy,
                    max(0, left.toInt()),
                    max(0, top.toInt()),
                    min(proxy.width, right.toInt()),
                    min(proxy.height, bottom.toInt()),
                )
                if (means != null) {
                    onSample(
                        FaceRppgSample(
                            timestampMs = timestampMs,
                            green = means.first,
                            luma = means.second,
                            faceArea = (box.width().toDouble() * box.height()) /
                                (width.toDouble() * height),
                            faceCenterX = box.exactCenterX().toDouble() / width,
                            faceCenterY = box.exactCenterY().toDouble() / height,
                        ),
                    )
                }
            }
            .addOnCompleteListener {
                // Closing the proxy releases the underlying buffer. Nothing
                // retains it, nothing encodes it, and nothing transmits it.
                proxy.close()
            }
    }

    /**
     * Mean green and luma over the region.
     *
     * CameraX delivers YUV_420_888, where the Y plane is already BT.601 luma, so
     * brightness needs no conversion and only green is derived.
     */
    private fun regionMeans(
        proxy: ImageProxy,
        startX: Int,
        startY: Int,
        endX: Int,
        endY: Int,
    ): Pair<Double, Double>? {
        if (endX - startX < 3 || endY - startY < 3) return null
        val planes = proxy.planes
        if (planes.size < 3) return null

        val yBuffer = planes[0].buffer
        val uBuffer = planes[1].buffer
        val vBuffer = planes[2].buffer
        val yRowStride = planes[0].rowStride
        val uvRowStride = planes[1].rowStride
        val uvPixelStride = planes[1].pixelStride

        var greenTotal = 0.0
        var lumaTotal = 0.0
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
                    x += 2
                    continue
                }
                val luma = (yBuffer.get(yIndex).toInt() and 0xFF).toDouble()
                val chromaU = (uBuffer.get(uvIndex).toInt() and 0xFF) - 128.0
                val chromaV = (vBuffer.get(uvIndex).toInt() and 0xFF) - 128.0

                greenTotal += clamp255(luma - 0.344136 * chromaU - 0.714136 * chromaV)
                lumaTotal += luma
                count += 1
                x += 2
            }
            y += 2
        }
        if (count == 0) return null
        return Pair(greenTotal / count, lumaTotal / count)
    }

    private fun clamp255(value: Double): Double = when {
        value < 0 -> 0.0
        value > 255 -> 255.0
        else -> value
    }
}

package com.rafaypair.android.pose

import android.content.Context
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.pose.PoseDetection
import com.google.mlkit.vision.pose.PoseLandmark
import com.google.mlkit.vision.pose.defaults.PoseDetectorOptions
import java.util.concurrent.Executors

/**
 * On-device camera pose capture.
 *
 * Frames never leave the process: each image is handed to ML Kit's local
 * detector, converted to the canonical thirteen-joint skeleton, and closed.
 * Nothing is written to disk and nothing is uploaded. Only the derived frames
 * escape this class, which is what makes the "no camera upload" guarantee
 * auditable at a single boundary.
 */
class PoseCaptureController(
    private val context: Context,
    private val onFrame: (PoseFrame) -> Unit,
) {
    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private val detector = PoseDetection.getClient(
        PoseDetectorOptions.Builder()
            .setDetectorMode(PoseDetectorOptions.STREAM_MODE)
            .build(),
    )
    private var provider: ProcessCameraProvider? = null

    fun start(lifecycleOwner: LifecycleOwner, previewView: PreviewView) {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            val cameraProvider = future.get()
            provider = cameraProvider

            val preview = Preview.Builder().build().also {
                it.surfaceProvider = previewView.surfaceProvider
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(analysisExecutor, ::analyze)

            cameraProvider.unbindAll()
            cameraProvider.bindToLifecycle(
                lifecycleOwner,
                CameraSelector.DEFAULT_FRONT_CAMERA,
                preview,
                analysis,
            )
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
    private fun analyze(proxy: androidx.camera.core.ImageProxy) {
        val image = proxy.image
        if (image == null) {
            proxy.close()
            return
        }
        val rotation = proxy.imageInfo.rotationDegrees
        val inputImage = InputImage.fromMediaImage(image, rotation)
        // The analyser runs on a single-threaded executor, so the detector is
        // never called concurrently and the proxy is closed exactly once.
        val width = if (rotation == 90 || rotation == 270) proxy.height else proxy.width
        val height = if (rotation == 90 || rotation == 270) proxy.width else proxy.height

        detector.process(inputImage)
            .addOnSuccessListener { pose ->
                val frame = canonicalFrame(
                    pose = pose,
                    timestampMs = proxy.imageInfo.timestamp / 1_000_000.0,
                    width = width.toDouble(),
                    height = height.toDouble(),
                )
                // The engine is invariant to horizontal mirroring and to left/right
                // labelling (see engines/pose-spec/SPEC.md §2), so a front-camera
                // frame needs no correction before it is handed over.
                if (frame != null) onFrame(frame)
            }
            .addOnCompleteListener {
                // Closing the proxy releases the underlying buffer. Nothing
                // retains it, nothing encodes it, and nothing transmits it.
                proxy.close()
            }
    }

    private companion object {
        /**
         * ML Kit reports pixel coordinates with a top-left origin, which matches
         * the engine's axis convention; only the normalization by frame size is
         * needed.
         */
        val LANDMARKS: Map<JointName, Int> = mapOf(
            JointName.NOSE to PoseLandmark.NOSE,
            JointName.LEFT_SHOULDER to PoseLandmark.LEFT_SHOULDER,
            JointName.RIGHT_SHOULDER to PoseLandmark.RIGHT_SHOULDER,
            JointName.LEFT_ELBOW to PoseLandmark.LEFT_ELBOW,
            JointName.RIGHT_ELBOW to PoseLandmark.RIGHT_ELBOW,
            JointName.LEFT_WRIST to PoseLandmark.LEFT_WRIST,
            JointName.RIGHT_WRIST to PoseLandmark.RIGHT_WRIST,
            JointName.LEFT_HIP to PoseLandmark.LEFT_HIP,
            JointName.RIGHT_HIP to PoseLandmark.RIGHT_HIP,
            JointName.LEFT_KNEE to PoseLandmark.LEFT_KNEE,
            JointName.RIGHT_KNEE to PoseLandmark.RIGHT_KNEE,
            JointName.LEFT_ANKLE to PoseLandmark.LEFT_ANKLE,
            JointName.RIGHT_ANKLE to PoseLandmark.RIGHT_ANKLE,
        )


        fun canonicalFrame(
            pose: com.google.mlkit.vision.pose.Pose,
            timestampMs: Double,
            width: Double,
            height: Double,
        ): PoseFrame? {
            if (width <= 0 || height <= 0) return null
            val joints = JointName.ALL.map { name ->
                val landmark = LANDMARKS[name]?.let(pose::getPoseLandmark)
                if (landmark == null) {
                    Joint(0.0, 0.0, 0.0)
                } else {
                    Joint(
                        x = landmark.position.x / width,
                        y = landmark.position.y / height,
                        visibility = landmark.inFrameLikelihood.toDouble(),
                    )
                }
            }
            return PoseFrame(timestampMs, joints)
        }

    }
}

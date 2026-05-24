package com.ciphertranslocal.app

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.database.Cursor
import android.graphics.Color
import android.media.MediaScannerConnection
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.view.View
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : TauriActivity() {
    private var multicastLock: WifiManager.MulticastLock? = null
    private var highPerfWifiLock: WifiManager.WifiLock? = null
    private var appWebView: WebView? = null
    private var darkTheme = false
    private val fileCopyExecutor = Executors.newSingleThreadExecutor()

    override val handleBackNavigation: Boolean = false

    companion object {
        private const val REQUEST_PICK_IMAGES = 7201
        private const val REQUEST_PICK_FILES = 7202
        private const val REQUEST_PICK_RECEIVE_DIRECTORY = 7203
        private const val PREFS_NAME = "ciphertranslocal_android"
        private const val PREF_CUSTOM_DIR_URI = "custom_directory_uri"
        private const val PREF_CUSTOM_DIR_NAME = "custom_directory_name"
        private const val FILE_COPY_BUFFER_SIZE = 1024 * 1024
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        super.onCreate(savedInstanceState)
        window.decorView.post { configureSystemBars() }
        configureKeyboardResize()
        requestRuntimePermissions()
        KeepAliveService.start(applicationContext)
        acquireMulticastLock()
        acquireHighPerfWifiLock()
        installBackHandler()
    }

    override fun onResume() {
        super.onResume()
        configureSystemBars()
    }

    override fun onWebViewCreate(webView: WebView) {
        appWebView = webView
        webView.setBackgroundColor(themeBackgroundColor())
        webView.settings.setSupportZoom(false)
        webView.settings.builtInZoomControls = false
        webView.settings.displayZoomControls = false
        webView.addJavascriptInterface(AndroidBridge(), "CipherTransLocalAndroid")
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)

        if (requestCode == REQUEST_PICK_RECEIVE_DIRECTORY) {
            handleReceiveDirectoryResult(resultCode, data)
            return
        }

        if (requestCode != REQUEST_PICK_IMAGES && requestCode != REQUEST_PICK_FILES) return

        if (resultCode != RESULT_OK || data == null) {
            dispatchPickedFiles(emptyList())
            return
        }

        val selectedUris = selectedFileUris(data)
        if (selectedUris.isEmpty()) {
            dispatchPickedFiles(emptyList(), "没有选择任何文件。")
            return
        }

        val selectedFiles = selectedUris.mapIndexed { index, uri -> pickedFileInfo(uri, index) }
        dispatchPreparingFiles(selectedFiles)
        fileCopyExecutor.execute {
            val paths = mutableListOf<String>()
            var errorMessage: String? = null

            try {
                selectedUris.forEach { uri ->
                    copyUriToCache(uri)?.let(paths::add)
                }
                if (paths.isEmpty()) {
                    errorMessage = "选择的文件无法读取，请检查系统文件权限后重试"
                }
            } catch (error: Exception) {
                error.printStackTrace()
                errorMessage = "选择的文件无法读取，请检查系统文件权限后重试"
            }

            dispatchPickedFiles(paths, errorMessage)
        }
    }

    override fun onDestroy() {
        releaseHighPerfWifiLock()
        multicastLock?.let {
            if (it.isHeld) it.release()
        }
        multicastLock = null
        fileCopyExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun acquireMulticastLock() {
        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        multicastLock = wifiManager?.createMulticastLock("ciphertranslocal-discovery")?.apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun configureKeyboardResize() {
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
    }

    private fun acquireHighPerfWifiLock() {
        if (highPerfWifiLock?.isHeld == true) return
        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        } else {
            WifiManager.WIFI_MODE_FULL_HIGH_PERF
        }
        highPerfWifiLock = wifiManager.createWifiLock(mode, "ciphertranslocal-transfer").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseHighPerfWifiLock() {
        highPerfWifiLock?.let {
            if (it.isHeld) it.release()
        }
        highPerfWifiLock = null
    }

    private fun configureSystemBars() {
        val lightBars = !darkTheme
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS)
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
        window.statusBarColor = themeBackgroundColor()
        window.navigationBarColor = themeNavigationColor()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(true)
            val controller = window.decorView.windowInsetsController ?: return
            val appearance = if (lightBars) {
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            } else {
                0
            }
            controller.setSystemBarsAppearance(
                appearance,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            )
        } else {
            var flags = 0
            if (lightBars) {
                flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    flags = flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                }
            }
            window.decorView.systemUiVisibility = flags
        }
    }

    private fun themeBackgroundColor(): Int =
        if (darkTheme) Color.rgb(2, 6, 23) else Color.rgb(248, 250, 252)

    private fun themeNavigationColor(): Int =
        if (darkTheme) Color.rgb(15, 23, 42) else Color.WHITE

    private fun requestRuntimePermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return

        val permissions = mutableListOf<String>()
        if (checkSelfPermission(android.Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(android.Manifest.permission.NEARBY_WIFI_DEVICES)
        }
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        if (permissions.isNotEmpty()) {
            requestPermissions(permissions.toTypedArray(), 1001)
        }
    }

    private fun installBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val webView = appWebView
                if (webView == null) {
                    moveTaskToBack(true)
                    return
                }

                webView.evaluateJavascript(
                    "(window.__CIPHERTRANSLOCAL_HANDLE_ANDROID_BACK__ && window.__CIPHERTRANSLOCAL_HANDLE_ANDROID_BACK__()) === true"
                ) { handled ->
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })
    }

    inner class AndroidBridge {
        @JavascriptInterface
        fun pickImages() {
            runOnUiThread {
                try {
                    val intent = Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI).apply {
                        type = "image/*"
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    startActivityForResult(Intent.createChooser(intent, "选择图片"), REQUEST_PICK_IMAGES)
                } catch (error: Exception) {
                    dispatchPickedFiles(emptyList(), "无法打开相册，请检查系统相册或存储权限")
                }
            }
        }

        @JavascriptInterface
        fun pickFiles() {
            runOnUiThread {
                try {
                    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQUEST_PICK_FILES)
                } catch (error: Exception) {
                    dispatchPickedFiles(emptyList(), "无法打开文件管理器，请检查系统文件管理器或存储权限")
                }
            }
        }

        @JavascriptInterface
        fun pickReceiveDirectory() {
            runOnUiThread {
                try {
                    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                        addFlags(
                            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
                        )
                    }
                    startActivityForResult(Intent.createChooser(intent, "选择接收目录"), REQUEST_PICK_RECEIVE_DIRECTORY)
                } catch (error: Exception) {
                    dispatchPickedDirectory(null, null, "无法打开目录选择器，请确认系统文件管理器可用")
                }
            }
        }

        @JavascriptInterface
        fun publishReceivedFile(path: String, fileName: String, fileType: String, saveToGallery: Boolean, saveToDownloads: Boolean): String {
            return try {
                val source = File(path)
                if (!source.exists()) return JSONObject(mapOf("ok" to false, "error" to "接收文件不存在，无法发布到系统目录")).toString()

                val results = JSONArray()
                val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                val customUri = prefs.getString(PREF_CUSTOM_DIR_URI, "").orEmpty()

                if (saveToDownloads) {
                    val downloadsUri = copyToPublicDownloads(source, fileName)
                    results.put(JSONObject(mapOf("type" to "downloads", "uri" to downloadsUri.toString())))
                }

                if (customUri.isNotBlank()) {
                    val published = copyToTreeUri(Uri.parse(customUri), source, fileName)
                    results.put(JSONObject(mapOf("type" to "custom", "uri" to published.toString())))
                }

                if (saveToGallery && fileType == "image") {
                    val galleryUri = copyImageToGallery(source, fileName)
                    results.put(JSONObject(mapOf("type" to "gallery", "uri" to galleryUri.toString())))
                }

                if (results.length() > 0 && source.exists()) {
                    source.delete()
                }

                JSONObject(mapOf("ok" to true, "results" to results)).toString()
            } catch (error: Exception) {
                error.printStackTrace()
                JSONObject(mapOf("ok" to false, "error" to (error.message ?: "保存到系统目录失败"))).toString()
            }
        }

        @JavascriptInterface
        fun setTransferPerformanceMode(enabled: Boolean) {
            runOnUiThread {
                if (enabled) {
                    acquireHighPerfWifiLock()
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        @JavascriptInterface
        fun setColorScheme(theme: String) {
            runOnUiThread {
                darkTheme = theme == "dark"
                appWebView?.setBackgroundColor(themeBackgroundColor())
                configureSystemBars()
            }
        }

        @JavascriptInterface
        fun showKeyboard() {
            runOnUiThread {
                val webView = appWebView ?: return@runOnUiThread
                webView.requestFocus()
                val inputManager = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                inputManager?.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT)
            }
        }
    }

    private fun handleReceiveDirectoryResult(resultCode: Int, data: Intent?) {
        if (resultCode != RESULT_OK || data?.data == null) {
            dispatchPickedDirectory(null, null, null)
            return
        }

        val uri = data.data!!
        val flags = data.flags and (
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        try {
            contentResolver.takePersistableUriPermission(uri, flags)
        } catch (error: Exception) {
            error.printStackTrace()
        }

        val name = documentTreeName(uri)
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_CUSTOM_DIR_URI, uri.toString())
            .putString(PREF_CUSTOM_DIR_NAME, name)
            .apply()

        dispatchPickedDirectory(uri.toString(), name, null)
    }

    private fun dispatchPickedFiles(paths: List<String>, error: String? = null) {
        val json = JSONArray(paths).toString()
        val payload = if (error == null) {
            "{detail:{paths:$json}}"
        } else {
            "{detail:{paths:$json,error:${JSONObject.quote(error)}}}"
        }
        appWebView?.post {
            appWebView?.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('ciphertranslocal-android-picked-files',$payload));",
                null
            )
        }
    }

    private fun dispatchPreparingFiles(files: List<JSONObject>) {
        val detail = JSONObject()
            .put("count", files.size)
            .put("files", JSONArray(files))
        appWebView?.post {
            appWebView?.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('ciphertranslocal-android-preparing-files',{detail:${detail}}));",
                null
            )
        }
    }

    private fun pickedFileInfo(uri: Uri, index: Int): JSONObject {
        val name = sanitizeFileName(queryDisplayName(uri) ?: "picked-${System.currentTimeMillis()}-$index")
        val size = querySize(uri)
        return JSONObject()
            .put("name", name)
            .put("size", size)
            .put("type", fileTypeForName(name))
    }

    private fun dispatchPickedDirectory(uri: String?, name: String?, error: String?) {
        val detail = JSONObject()
        if (uri != null) detail.put("uri", uri)
        if (name != null) detail.put("name", name)
        if (error != null) detail.put("error", error)
        appWebView?.post {
            appWebView?.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('ciphertranslocal-android-picked-directory',{detail:${detail}}));",
                null
            )
        }
    }

    private fun selectedFileUris(data: Intent): List<Uri> {
        val uris = mutableListOf<Uri>()
        val clipData = data.clipData
        if (clipData != null) {
            for (index in 0 until clipData.itemCount) {
                clipData.getItemAt(index).uri?.let(uris::add)
            }
        } else {
            data.data?.let(uris::add)
        }
        return uris
    }

    private fun copyUriToCache(uri: Uri): String? {
        var target: File? = null
        return try {
            val displayName = sanitizeFileName(queryDisplayName(uri) ?: "picked-${System.currentTimeMillis()}")
            val targetDir = File(cacheDir, "picked-files").apply { mkdirs() }
            val destination = uniqueFile(targetDir, displayName)
            target = destination
            contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(destination).use { output -> input.copyTo(output, FILE_COPY_BUFFER_SIZE) }
            } ?: return null
            destination.absolutePath
        } catch (error: Exception) {
            target?.delete()
            error.printStackTrace()
            null
        }
    }

    private fun copyToTreeUri(treeUri: Uri, source: File, fileName: String): Uri {
        val treeDocumentId = DocumentsContract.getTreeDocumentId(treeUri)
        val parentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, treeDocumentId)
        val mimeType = guessMimeType(fileName)
        val destinationName = uniqueDocumentName(parentUri, sanitizeFileName(fileName))
        val destinationUri = DocumentsContract.createDocument(contentResolver, parentUri, mimeType, destinationName)
            ?: throw IllegalStateException("无法在自定义目录创建文件")

        contentResolver.openOutputStream(destinationUri, "w")?.use { output ->
            source.inputStream().use { input -> input.copyTo(output) }
        } ?: throw IllegalStateException("无法写入自定义目录")

        return destinationUri
    }

    private fun copyToPublicDownloads(source: File, fileName: String): Uri {
        val safeName = sanitizeFileName(fileName)
        val mimeType = guessMimeType(safeName)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                put(MediaStore.Downloads.MIME_TYPE, mimeType)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/CipherTransLocal")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("无法写入系统下载目录")

            contentResolver.openOutputStream(uri, "w")?.use { output ->
                source.inputStream().use { input -> input.copyTo(output) }
            } ?: throw IllegalStateException("无法写入系统下载目录")

            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
            return uri
        }

        val downloadsDir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "CipherTransLocal").apply {
            mkdirs()
        }
        val target = uniqueFile(downloadsDir, safeName)
        source.inputStream().use { input ->
            FileOutputStream(target).use { output -> input.copyTo(output) }
        }
        MediaScannerConnection.scanFile(this, arrayOf(target.absolutePath), arrayOf(mimeType), null)
        return Uri.fromFile(target)
    }

    private fun copyImageToGallery(source: File, fileName: String): Uri {
        val safeName = sanitizeFileName(fileName)
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, safeName)
            put(MediaStore.Images.Media.MIME_TYPE, guessMimeType(safeName))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/CipherTransLocal")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
        }

        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        } else {
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }
        val uri = contentResolver.insert(collection, values)
            ?: throw IllegalStateException("无法写入系统相册")

        contentResolver.openOutputStream(uri, "w")?.use { output ->
            source.inputStream().use { input -> input.copyTo(output) }
        } ?: throw IllegalStateException("无法写入系统相册")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.clear()
            values.put(MediaStore.Images.Media.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
        } else {
            MediaScannerConnection.scanFile(this, arrayOf(source.absolutePath), arrayOf(guessMimeType(safeName)), null)
        }

        return uri
    }

    private fun uniqueDocumentName(parentUri: Uri, desiredName: String): String {
        val existing = mutableSetOf<String>()
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
            parentUri,
            DocumentsContract.getDocumentId(parentUri)
        )

        var cursor: Cursor? = null
        try {
            cursor = contentResolver.query(
                childrenUri,
                arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                null,
                null,
                null
            )
            while (cursor != null && cursor.moveToNext()) {
                existing.add(cursor.getString(0))
            }
        } catch (error: Exception) {
            error.printStackTrace()
        } finally {
            cursor?.close()
        }

        if (!existing.contains(desiredName)) return desiredName

        val dot = desiredName.lastIndexOf('.')
        val stem = if (dot > 0) desiredName.substring(0, dot) else desiredName
        val ext = if (dot > 0) desiredName.substring(dot) else ""
        var index = 1
        while (index < 1000) {
            val candidate = "$stem ($index)$ext"
            if (!existing.contains(candidate)) return candidate
            index += 1
        }
        return "${System.currentTimeMillis()}-$desiredName"
    }

    private fun documentTreeName(uri: Uri): String {
        val documentId = DocumentsContract.getTreeDocumentId(uri)
        return documentId.substringAfterLast(':').ifBlank { "自定义接收目录" }
    }

    private fun queryDisplayName(uri: Uri): String? {
        var cursor: Cursor? = null
        return try {
            cursor = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            if (cursor != null && cursor.moveToFirst()) cursor.getString(0) else uri.lastPathSegment
        } finally {
            cursor?.close()
        }
    }

    private fun querySize(uri: Uri): Long {
        var cursor: Cursor? = null
        return try {
            cursor = contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else 0L
        } catch (_: Exception) {
            0L
        } finally {
            cursor?.close()
        }
    }

    private fun fileTypeForName(fileName: String): String {
        val lower = fileName.lowercase()
        return when {
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") || lower.endsWith(".gif") || lower.endsWith(".bmp") || lower.endsWith(".webp") -> "image"
            lower.endsWith(".mp4") || lower.endsWith(".avi") || lower.endsWith(".mov") || lower.endsWith(".mkv") || lower.endsWith(".webm") -> "video"
            lower.endsWith(".mp3") || lower.endsWith(".wav") || lower.endsWith(".flac") || lower.endsWith(".aac") -> "audio"
            lower.endsWith(".pdf") || lower.endsWith(".doc") || lower.endsWith(".docx") || lower.endsWith(".txt") -> "document"
            lower.endsWith(".zip") || lower.endsWith(".rar") || lower.endsWith(".7z") -> "archive"
            else -> "other"
        }
    }

    private fun guessMimeType(fileName: String): String {
        val lower = fileName.lowercase()
        return when {
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".gif") -> "image/gif"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".bmp") -> "image/bmp"
            lower.endsWith(".txt") -> "text/plain"
            lower.endsWith(".pdf") -> "application/pdf"
            lower.endsWith(".zip") -> "application/zip"
            else -> "application/octet-stream"
        }
    }

    private fun sanitizeFileName(name: String): String {
        return name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "picked-file" }
    }

    private fun uniqueFile(dir: File, name: String): File {
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var candidate = File(dir, name)
        var index = 1
        while (candidate.exists()) {
            candidate = File(dir, "$stem ($index)$ext")
            index += 1
        }
        return candidate
    }
}

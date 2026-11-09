package com.openbitfun.mobile.app.ui.chat

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.platform.launchComposerActivity

/** Dictation belongs to the session that launched it, including across recreation. */
@Composable
internal fun rememberComposerVoiceInput(owner: String, onText: (String) -> Unit): () -> Unit {
    val context = LocalContext.current
    var pendingOwner by rememberSaveable { mutableStateOf<String?>(null) }
    val currentOwner by rememberUpdatedState(owner)
    val receiveText by rememberUpdatedState(onText)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val target = pendingOwner
        pendingOwner = null
        if (target == currentOwner && result.resultCode == Activity.RESULT_OK) {
            val text = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull().orEmpty()
            if (text.isNotBlank()) receiveText(text)
        }
    }
    return {
        pendingOwner = owner
        if (!launchComposerActivity(context, R.string.chat_voice_input_unavailable) {
                launcher.launch(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                })
            }) {
            pendingOwner = null
        }
    }
}

[English] | [简体中文](语音与实时通话) · [Home](Home)

# Voice input and realtime calls

## Two separate workflows

| Workflow | Result | Review boundary |
| --- | --- | --- |
| Input transcription | Recording becomes text in the composer | Edit before sending |
| Realtime call | Ongoing spoken conversation with audible replies | Project/tool actions still follow their permissions |

Realtime calls can ask the assistant to enter a project, run or stop work, and speak brief progress. A local transcription model does not make a configured cloud realtime call local.

## Configure and test transcription

1. Open the standalone Voice settings page.
2. Enable voice and choose the configured local or cloud recognition path.
3. For local recognition, inspect model download/install/verification state and complete setup.
4. Select the microphone and recognition language or automatic detection.
5. Run the microphone/recognition test, then record from the chat input.
6. Finish to return text to the composer, edit it, and send; cancel to discard the recording.

Check microphone OS permissions, model state, service credentials, network, and test errors before retrying. Do not delete unrelated models or application data as a general recovery step.

## Realtime collaboration

Configure the realtime voice service, start a call from the available client entry, and confirm the active project before asking for execution. Distinguish stopping a project task from ending the call; do not assume ending audio undoes work already performed.

Provider/model availability, audio support, and surface entrypoints differ by installation. Do not infer mobile/Bot or remote-host voice parity from desktop support. Never route audio to a controller-local service silently if the selected surface cannot support it.

Review what audio and context leave the device. Use text for sensitive instructions when you cannot verify the service's privacy settings.

[Voice reference](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/docs/interactive-capabilities/capabilities/feature.voice-input.md)

> Screenshot pending: S34 — voice setup/test; S35 — recording with editable text; S36 — realtime call and project task.

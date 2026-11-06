## Completion and verification — all formats

The engine writes Office files directly; it does not depend on an installed Office application. Finish edits, inspect warnings, then use `read` to verify changed content, indexes, formulas or chart references. A successful write plus this structural check is the default completion path.

Visual inspection is a separate task when the user requests it or the deliverable requires it. Use a known available viewer on the machine that owns the file. Do not automatically probe, install or repair LibreOffice/soffice or other Office packages, search unrelated application directories, or build a substitute renderer just because `visual_rendered` is false. If no suitable viewer is available, deliver the file and state that visual inspection was not performed.

Report evidence precisely: a structure read, geometry estimate, preview in one viewer, and verification in the intended Office application are different checks. Never claim Excel/WPS/Word/PowerPoint compatibility based only on another viewer or a custom drawing of the model. Keep the original file when previewing; saving in another application changes its editable-source fingerprint.

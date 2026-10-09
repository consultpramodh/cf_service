# Exact Apps Script history backup

Each content.json.gz is the complete projects.getContent response. manifest.json records SHA-256 for every original source string and the archive. inventory.json maps all versions and deployment pins. HEAD is captured separately.

Recovery: gunzip the chosen archive, read files[], restore every source string using its name/type (SERVER_JS -> .gs, HTML -> .html, JSON -> .json), push the complete project, verify a fresh read-back, and deploy a new version at the existing deployment ID. Deleted version numbers cannot be restored.

This backup contains source and manifests, not Script Properties, credentials, spreadsheet data, installed triggers, or external records. No Apps Script write or deletion is performed by this workflow.

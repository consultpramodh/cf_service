# Operations Web URL correction — 2026-10-23

Google deployment metadata for version 207 returned a domain-specific WEB_APP entry point. The previously published generic URL was constructed rather than copied from this field. Both Site links now use the returned domain URL.

Access remains DOMAIN / USER_DEPLOYING. The deployer is pramodh@classicfireplace.ca. No Apps Script deployment, source in production, intake webhook, or permission was changed during this URL correction. The release helper now reads the canonical URL from deployment metadata and validates the protection mode.

Deployment metadata was read through the authenticated Google Apps Script API by GitHub Actions run 40000201478. Hosted request loading and saves still require a signed-in authorized user test.

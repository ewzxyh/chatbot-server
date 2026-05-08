# Cloudflare R2 storage

Tiledesk native uploads can store files in Cloudflare R2 instead of MongoDB GridFS.

The frontend upload engine stays `native`; the server keeps the existing API URLs and proxies file reads through `/files` and `/:projectid/files`.

## Environment

```env
FILE_STORAGE_DRIVER=r2
R2_ACCOUNT_ID=...
R2_BUCKET=chatcase-uploads
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_REGION=auto
R2_KEY_PREFIX=prod
```

`R2_ENDPOINT` is optional. If it is not set, the server uses:

```text
https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
```

## Behavior

- New uploads are written to R2.
- File reads try R2 first.
- If a file is not found in R2, the server falls back to legacy GridFS buckets (`files`, then `images`).
- Existing GridFS files keep working while new objects are stored externally.

Keep the R2 bucket private. The application serves files through the API, so public bucket URLs are not required.

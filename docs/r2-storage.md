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

## Bucket separation

Use `R2_*` only for application uploads and conversation attachments.

Mongo backup jobs should use `MONGO_BACKUP_R2_*` variables, not the generic `R2_*` variables. This keeps uploaded customer files separate from backup archives.

Recommended production layout:

```env
FILE_STORAGE_DRIVER=r2
R2_BUCKET=chatcase-uploads
R2_KEY_PREFIX=prod

MONGO_BACKUP_R2_BUCKET=chatcase-backups
MONGO_BACKUP_R2_PREFIX=backups/mongo
```

If one bucket is used temporarily, keep distinct prefixes, for example `uploads/prod` and `backups/mongo`.

## Behavior

- New uploads are written to R2.
- File reads try R2 first.
- If a file is not found in R2, the server falls back to legacy GridFS buckets (`files`, then `images`).
- Existing GridFS files keep working while new objects are stored externally.

Keep the R2 bucket private. The application serves files through the API, so public bucket URLs are not required.

## Optional signed CDN Worker

For production media optimization, ChatCase can generate signed URLs for a Cloudflare Worker in front of the same private R2 bucket:

```env
MEDIA_CDN_ENABLED=true
MEDIA_CDN_BASE_URL=https://media.chatcase.com.br
MEDIA_CDN_SIGNING_SECRET=...
MEDIA_CDN_DEFAULT_TTL_SECONDS=604800
MEDIA_CDN_REPLACE_SRC=false
```

When enabled, new WABA and CaseZap media metadata receives `cdnUrl` and `downloadCdnUrl` while keeping `/api/files` in `metadata.src`/`downloadUrl` as a fallback. Outbound channel translators prefer CDN URLs when present. Use `MEDIA_CDN_REPLACE_SRC=true` only after validating expiration behavior in the chat UI, because `metadata.src` is persisted on old messages.

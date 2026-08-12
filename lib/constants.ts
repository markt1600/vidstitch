export const MAX_FILES = 6;

// Per-file and combined caps. The serverless /tmp scratch disk is 512 MB and
// must hold every input plus the merged output, so the combined input size is
// capped well below half of it.
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
// Server-side re-check allows slight slack over the client cap.
export const MAX_TOTAL_BYTES_SERVER = 220 * 1024 * 1024;

// How long a merged file may live before it is deleted.
export const MERGED_RETENTION_MS = 5 * 60 * 1000;

// File-sharing space: how long shared files (and their link) live, and how
// many files one share can hold.
export const SHARE_RETENTION_MS = 5 * 60 * 1000;
export const MAX_SHARE_FILES = 10;

// Source uploads are deleted as soon as a merge finishes. This backstop
// removes any upload whose merge never ran (e.g. the user closed the tab
// between uploading and merging).
export const UPLOAD_ORPHAN_MS = 15 * 60 * 1000;

export const UPLOAD_PREFIX = "uploads/";
export const MERGED_PREFIX = "merged/";
export const SHARE_PREFIX = "shares/";

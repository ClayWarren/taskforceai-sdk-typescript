/** Represents an uploaded file. */
export interface File {
  id: string;
  filename: string;
  purpose: string;
  bytes: number;
  created_at: string;
  mime_type?: string;
}

/** Options for uploading a file. */
export interface FileUploadOptions {
  purpose?: string;
  mime_type?: string;
}

/** Response containing a list of files. */
export interface FileListResponse {
  files: File[];
  total: number;
}

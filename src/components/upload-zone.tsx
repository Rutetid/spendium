'use client';

import { useMutation } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';

interface UploadResult {
  id: string;
  uploadedAt: string;
  rawTextExpiresAt: string;
  totalPages: number;
  text: string;
}

export function UploadZone() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(json?.error ?? 'Upload failed.');
      }
      return json as UploadResult;
    },
    onSuccess: (data) => setResult(data),
  });

  return (
    <section className="mb-8">
      <motion.div
        role="button"
        tabIndex={0}
        aria-label="Upload bank statement PDF"
        animate={{ scale: isDragging ? 1.02 : 1 }}
        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node)) {
            return;
          }
          setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file) upload.mutate(file);
        }}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
          isDragging
            ? 'border-primary bg-primary/5'
            : 'border-muted-foreground/25 hover:border-muted-foreground/50'
        }`}
      >
        <Upload className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium">
          Drag &amp; drop your bank statement PDF
        </p>
        <p className="text-xs text-muted-foreground">
          or click to browse — the file is processed in memory and never stored
        </p>
        {upload.isPending && (
          <p className="mt-2 text-xs text-muted-foreground">
            Extracting text…
          </p>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate(file);
            event.target.value = '';
          }}
        />
      </motion.div>

      {upload.isError && (
        <p className="mt-2 text-sm text-destructive">{upload.error.message}</p>
      )}

      <AnimatePresence>
        {result && (
          <motion.div
            key={result.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-4 rounded-lg border"
          >
            <div className="flex items-start justify-between gap-4 border-b px-4 py-2">
              <div>
                <h2 className="text-sm font-medium">
                  Extracted &amp; sanitized text
                </h2>
                <p className="text-xs text-muted-foreground">
                  {result.totalPages} page{result.totalPages === 1 ? '' : 's'}{' '}
                  · text expires{' '}
                  {new Date(result.rawTextExpiresAt).toLocaleDateString()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setResult(null)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words px-4 py-3 text-xs">
              {result.text}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

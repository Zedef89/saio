import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { logger } from '../lib/logger'

/**
 * Allegati per le sessioni Claude: SAIO NON trascrive e NON analizza nulla.
 * Salva il file sul disco del Mac e restituisce il path, che il frontend inietta
 * nel prompt — Claude poi legge immagini/PDF da path e trascrive gli audio con Groq.
 */
const UPLOAD_ROOT = process.env.SAIO_UPLOAD_DIR || path.join(os.homedir(), 'SAIO-uploads')
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB: audio lunghi e PDF pesanti

// Whitelist: immagini, documenti, audio, testo/codice
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
  'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/flac',
  'video/webm', 'video/mp4', 'video/quicktime',
])

function sanitizeName(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|-+$/g, '')
      .slice(0, 80) || 'file'
  )
}

/** projectId come arriva dalla UI (`tmux-com-deliverable`, uuid, ...) → nome cartella sicuro. */
function safeProjectDir(projectId: string): string {
  return (
    projectId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 60) || 'sessione'
  )
}

function stamp(): { day: string; time: string } {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
  }
}

export function uploadsRouter(): Router {
  const router = Router()

  const upload = multer({
    storage: multer.diskStorage({
      destination: async (req, _file, cb) => {
        const { day } = stamp()
        const dir = path.join(UPLOAD_ROOT, safeProjectDir(String(req.params.projectId || '')), day)
        try {
          await fs.mkdir(dir, { recursive: true })
          cb(null, dir)
        } catch (err) {
          cb(err as Error, dir)
        }
      },
      filename: (_req, file, cb) => {
        const { time } = stamp()
        cb(null, `${time}-${sanitizeName(file.originalname)}`)
      },
    }),
    limits: { fileSize: MAX_FILE_SIZE, files: 5 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_MIME.has(file.mimetype)) {
        return cb(new Error(`Tipo di file non consentito: ${file.mimetype}`))
      }
      cb(null, true)
    },
  })

  router.post('/:projectId', (req, res) => {
    upload.array('files', 5)(req, res, (err: unknown) => {
      if (err) {
        logger.warn(`[uploads] rifiutato: ${String((err as Error).message)}`)
        return res.status(400).json({ error: 'upload_failed', message: String((err as Error).message) })
      }
      const files = (req.files as Express.Multer.File[]) || []
      if (files.length === 0) return res.status(400).json({ error: 'no_files' })
      const saved = files.map((f) => ({
        name: f.originalname,
        path: f.path,
        size: f.size,
        mime: f.mimetype,
      }))
      logger.info(`[uploads] ${saved.length} file salvati in ${path.dirname(saved[0].path)}`)
      res.json({ ok: true, files: saved })
    })
  })

  return router
}

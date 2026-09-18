/**
 * Resolve a file from `public/` against the build's base path.
 *
 * Vite rewrites root-absolute URLs in CSS and index.html, but not strings in
 * TS/TSX. Without this, `/video/x.mp4` stays root-absolute: fine on the site's
 * own domain (base '/'), broken behind a holding portal where the build is
 * based at e.g. `/funpay/web/` — the request lands on the portal's HTML and
 * the <video> fails with MEDIA_ERR_SRC_NOT_SUPPORTED.
 */
export function publicAsset(path: string): string {
  if (!path.startsWith('/')) return path;
  return import.meta.env.BASE_URL.replace(/\/$/, '') + path;
}

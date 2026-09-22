"""Serving the built front end from the API process, and the response headers that protect it."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# The dashboard can write to databases, so the page must not be framed, sniffed or cached.
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
}
# Only applied to the app's own HTML (Swagger UI at /docs loads scripts from a CDN and must not get it).
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)
IMMUTABLE = "public, max-age=31536000, immutable"


def install_headers(app: FastAPI) -> None:
    """Security headers on every response, and no caching of API data (it can contain row contents)."""

    @app.middleware("http")
    async def headers(request: Request, call_next):
        response = await call_next(request)
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response


def usable(root: Path | None) -> bool:
    return root is not None and (root / "index.html").is_file()


def install_front(app: FastAPI, root: Path) -> None:
    """Serve `root` (a Vite build): hashed assets, root files, and index.html for client-side routes."""
    root = root.resolve()
    if (root / "assets").is_dir():
        app.mount("/assets", _Assets(directory=root / "assets"), name="assets")

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def front(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="not found")  # unknown API routes stay JSON errors
        if path:
            candidate = (root / path).resolve()
            if candidate.is_file() and candidate.is_relative_to(root):
                return FileResponse(candidate)
            if "." in path.rsplit("/", 1)[-1]:
                raise HTTPException(status_code=404, detail="not found")  # a missing file, not a page
        return FileResponse(
            root / "index.html", headers={"Cache-Control": "no-cache", "Content-Security-Policy": CONTENT_SECURITY_POLICY}
        )


class _Assets(StaticFiles):
    """Vite names assets by content hash, so browsers may keep them for good."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = IMMUTABLE
        return response

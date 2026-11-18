from typing import Any

from litestar import Request
from litestar import Response
from litestar import post
from litestar.params import FromPath

from server.projects.workspaces import parse_workspace_id
from server.routes.common import JsonDict
from server.routes.common import error
from server.uploads.files import MAX_UPLOAD_BYTES
from server.uploads.files import save_upload
from server.uploads.files import valid_upload_name


@post(
    "/api/workspaces/{project_id:str}/{name:str}/files",
    status_code=200,
    request_max_body_size=MAX_UPLOAD_BYTES,
)
async def upload_workspace_file(
    request: Request[Any, Any, Any], project_id: FromPath[str], name: FromPath[str]
) -> Response[JsonDict]:
    """Drop a file from the browser into the root of a workspace.

    The body is the file's raw bytes and `?filename=` its name. A name that's already taken gets a
    number added rather than being overwritten; the response says what it was saved as.
    """
    workspace = parse_workspace_id(f"{project_id}/{name}")
    if workspace is None:
        return error(400, error="bad_request", message="invalid workspace id")
    if not workspace.path.is_dir():
        return error(404, error="not_found", message=f"no workspace {project_id}/{name}")

    filename = request.query_params.get("filename") or ""
    if not valid_upload_name(filename):
        return error(400, error="bad_request", message=f"invalid file name {filename!r}")

    path = await save_upload(workspace.path, filename, request.stream())
    return Response(content={"path": str(path), "name": path.name})

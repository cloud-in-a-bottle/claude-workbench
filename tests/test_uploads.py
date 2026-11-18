from pathlib import Path

import pytest
from litestar import Litestar
from litestar.testing import TestClient

from server import app as srv
from server.projects.workspaces import Workspace
from server.uploads.files import valid_upload_name

URL = "/api/workspaces/proj/ws/files"


def _client() -> TestClient[Litestar]:
    return TestClient(app=srv.app)


@pytest.fixture
def workspace() -> Path:
    path = Workspace(project_id="proj", name="ws").path
    path.mkdir(parents=True)
    return path


def test_drops_the_file_in_the_workspace_root(workspace: Path) -> None:
    with _client() as client:
        resp = client.post(URL, params={"filename": "notes.txt"}, content=b"hello")
    assert resp.status_code == 200
    assert resp.json() == {"path": str(workspace / "notes.txt"), "name": "notes.txt"}
    assert (workspace / "notes.txt").read_bytes() == b"hello"
    # No temp file left behind.
    assert sorted(p.name for p in workspace.iterdir()) == ["notes.txt"]


def test_never_overwrites_numbering_the_new_one_instead(workspace: Path) -> None:
    (workspace / "report.pdf").write_bytes(b"original")
    (workspace / ".env").write_bytes(b"original")
    with _client() as client:
        first = client.post(URL, params={"filename": "report.pdf"}, content=b"one")
        second = client.post(URL, params={"filename": "report.pdf"}, content=b"two")
        dotfile = client.post(URL, params={"filename": ".env"}, content=b"three")
    assert first.json()["name"] == "report (1).pdf"
    assert second.json()["name"] == "report (2).pdf"
    assert dotfile.json()["name"] == ".env (1)"
    assert (workspace / "report.pdf").read_bytes() == b"original"
    assert (workspace / "report (2).pdf").read_bytes() == b"two"


def test_an_empty_file_is_still_a_file(workspace: Path) -> None:
    with _client() as client:
        resp = client.post(URL, params={"filename": "empty"}, content=b"")
    assert resp.status_code == 200
    assert (workspace / "empty").read_bytes() == b""


@pytest.mark.parametrize("name", ["", ".", "..", "../escape", "a/b", "a\\b", "x" * 300])
def test_refuses_names_that_are_not_a_plain_file_name(workspace: Path, name: str) -> None:
    assert not valid_upload_name(name)
    with _client() as client:
        resp = client.post(URL, params={"filename": name}, content=b"x")
    assert resp.status_code == 400
    assert list(workspace.iterdir()) == []


def test_unknown_workspace_is_a_404() -> None:
    with _client() as client:
        resp = client.post(URL, params={"filename": "a.txt"}, content=b"x")
    assert resp.status_code == 404

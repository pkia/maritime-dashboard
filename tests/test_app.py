"""API smoke tests using Flask's test client.

These exercise every route without hardware: on a machine with no SDR,
systemd or state files the endpoints must still answer with sane defaults.
"""
import app as dashboard

client = dashboard.app.test_client()


def test_index_serves_page():
    r = client.get("/")
    assert r.status_code == 200
    assert b"<title>Maritime Dashboard</title>" in r.data


def test_api_status_shape():
    r = client.get("/api/status")
    assert r.status_code == 200
    data = r.get_json()
    for key in ("sdr_detected", "ais_running", "cpu_temp", "uptime",
                "mem_used", "signal_db", "time"):
        assert key in data


def test_api_status_degrades_without_hardware():
    # SDR/systemd presence is reported as a boolean either way - the
    # endpoint must answer, never crash, whatever hardware is attached.
    assert isinstance(client.get("/api/status").get_json()["sdr_detected"], bool)


def test_api_noaa_returns_images_list():
    r = client.get("/api/noaa")
    assert r.status_code == 200
    assert isinstance(r.get_json()["images"], list)


def test_api_spectrum_returns_payload():
    r = client.get("/api/spectrum")
    assert r.status_code == 200
    assert "scans" in r.get_json()


def test_api_onlineships_returns_shape():
    r = client.get("/api/onlineships")
    assert r.status_code == 200
    data = r.get_json()
    assert "ok" in data and isinstance(data["ships"], list)


def test_onlineships_refresh_is_idempotent():
    assert client.post("/api/onlineships/refresh").status_code == 200
    assert client.post("/api/onlineships/refresh").status_code == 200

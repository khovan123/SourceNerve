#!/usr/bin/env python3
"""SourceNerve Wayland RemoteDesktop portal helper.

Keeps one D-Bus connection alive for the lifetime of the helper because XDG
RemoteDesktop sessions are scoped to the caller's bus connection. The Electron
parent communicates over bounded JSON-lines stdin/stdout.
"""

from __future__ import annotations

import json
import sys
import uuid

import dbus
import dbus.mainloop.glib
from gi.repository import GLib

PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
REMOTE_IFACE = "org.freedesktop.portal.RemoteDesktop"
SCREENCAST_IFACE = "org.freedesktop.portal.ScreenCast"
SESSION_IFACE = "org.freedesktop.portal.Session"
REQUEST_IFACE = "org.freedesktop.portal.Request"
PROPERTIES_IFACE = "org.freedesktop.DBus.Properties"
KEYBOARD = 1
POINTER = 2
MONITOR = 1
BTN_LEFT = 272
REQUEST_TIMEOUT_MS = 120_000


def _json_safe(value):
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (dbus.String, dbus.ObjectPath)):
        return str(value)
    if isinstance(value, dbus.Boolean):
        return bool(value)
    if isinstance(value, (dbus.Int16, dbus.Int32, dbus.Int64, dbus.UInt16, dbus.UInt32, dbus.UInt64, dbus.Byte)):
        return int(value)
    if isinstance(value, dbus.Double):
        return float(value)
    return value


class RemoteDesktopPortal:
    def __init__(self) -> None:
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        self.bus = dbus.SessionBus()
        self.portal_object = self.bus.get_object(PORTAL_BUS, PORTAL_PATH)
        self.remote = dbus.Interface(self.portal_object, REMOTE_IFACE)
        self.screencast = dbus.Interface(self.portal_object, SCREENCAST_IFACE)
        self.properties = dbus.Interface(self.portal_object, PROPERTIES_IFACE)
        self.session_handle: str | None = None
        self.granted_devices = 0
        self.streams: list = []
        self.restore_token: str | None = None

    def probe(self) -> dict:
        available = int(self.properties.Get(REMOTE_IFACE, "AvailableDeviceTypes"))
        version = int(self.properties.Get(REMOTE_IFACE, "version"))
        screen_sources = int(self.properties.Get(SCREENCAST_IFACE, "AvailableSourceTypes"))
        screen_version = int(self.properties.Get(SCREENCAST_IFACE, "version"))
        return {
            "availableDeviceTypes": available,
            "version": version,
            "keyboard": bool(available & KEYBOARD),
            "pointer": bool(available & POINTER),
            "screenCastMonitor": bool(screen_sources & MONITOR),
            "screenCastVersion": screen_version,
        }

    def ensure_session(self, restore_token: str | None = None, persist_mode: int = 2) -> dict:
        if self.session_handle is not None and (self.granted_devices & (KEYBOARD | POINTER)) == (KEYBOARD | POINTER) and self.streams:
            return {
                "sessionActive": True,
                "devices": self.granted_devices,
                "streams": _json_safe(self.streams),
                "restoreToken": self.restore_token,
            }

        probe = self.probe()
        if not probe["keyboard"] or not probe["pointer"]:
            raise RuntimeError("Wayland RemoteDesktop portal does not expose both keyboard and pointer devices")
        if not probe["screenCastMonitor"]:
            raise RuntimeError("Wayland ScreenCast portal does not expose monitor sources required for absolute pointer control")

        session_token = self._token("session")
        created = self._request(
            self.remote.CreateSession,
            [],
            {
                "handle_token": dbus.String(self._token("create")),
                "session_handle_token": dbus.String(session_token),
            },
        )
        session_handle = str(created.get("session_handle") or "")
        if not session_handle:
            raise RuntimeError("RemoteDesktop portal did not return a session handle")
        self.session_handle = session_handle

        try:
            device_options = {
                "handle_token": dbus.String(self._token("devices")),
                "types": dbus.UInt32(KEYBOARD | POINTER),
            }
            if int(probe["version"]) >= 2:
                if persist_mode not in (0, 1, 2):
                    raise ValueError("invalid RemoteDesktop persist mode")
                device_options["persist_mode"] = dbus.UInt32(persist_mode)
                if restore_token:
                    device_options["restore_token"] = dbus.String(restore_token)
            self._request(
                self.remote.SelectDevices,
                [dbus.ObjectPath(session_handle)],
                device_options,
            )
            self._request(
                self.screencast.SelectSources,
                [dbus.ObjectPath(session_handle)],
                {
                    "handle_token": dbus.String(self._token("sources")),
                    "types": dbus.UInt32(MONITOR),
                    "multiple": dbus.Boolean(True),
                },
            )
            started = self._request(
                self.remote.Start,
                [dbus.ObjectPath(session_handle), dbus.String("")],
                {"handle_token": dbus.String(self._token("start"))},
            )
            devices = int(started.get("devices", 0))
            if (devices & (KEYBOARD | POINTER)) != (KEYBOARD | POINTER):
                raise RuntimeError("RemoteDesktop portal permission did not grant both keyboard and pointer")
            streams = started.get("streams") or []
            if not isinstance(streams, (list, tuple)) or not streams:
                raise RuntimeError("RemoteDesktop portal did not return any monitor streams for absolute pointer control")
            self.granted_devices = devices
            self.streams = _json_safe(streams)
            next_restore_token = started.get("restore_token")
            self.restore_token = str(next_restore_token) if next_restore_token else None
            return {
                "sessionActive": True,
                "devices": devices,
                "streams": self.streams,
                "restoreToken": self.restore_token,
            }
        except Exception:
            self.close_session()
            raise

    def pointer_motion(self, dx: float, dy: float) -> None:
        session = self._session()
        self.remote.NotifyPointerMotion(
            dbus.ObjectPath(session),
            dbus.Dictionary({}, signature="sv"),
            dbus.Double(dx),
            dbus.Double(dy),
        )

    def pointer_motion_absolute(self, stream: int, x: float, y: float) -> None:
        session = self._session()
        self.remote.NotifyPointerMotionAbsolute(
            dbus.ObjectPath(session),
            dbus.Dictionary({}, signature="sv"),
            dbus.UInt32(stream),
            dbus.Double(x),
            dbus.Double(y),
        )

    def click_left(self) -> None:
        session = self._session()
        options = dbus.Dictionary({}, signature="sv")
        self.remote.NotifyPointerButton(dbus.ObjectPath(session), options, dbus.Int32(BTN_LEFT), dbus.UInt32(1))
        self.remote.NotifyPointerButton(dbus.ObjectPath(session), options, dbus.Int32(BTN_LEFT), dbus.UInt32(0))

    def key_sequence(self, events: list[dict]) -> None:
        session = self._session()
        options = dbus.Dictionary({}, signature="sv")
        for event in events:
            code = int(event["code"])
            state = int(event["state"])
            if state not in (0, 1):
                raise ValueError("keyboard event state must be 0 or 1")
            self.remote.NotifyKeyboardKeycode(
                dbus.ObjectPath(session), options, dbus.Int32(code), dbus.UInt32(state)
            )

    def keysym_sequence(self, events: list[dict]) -> None:
        session = self._session()
        options = dbus.Dictionary({}, signature="sv")
        for event in events:
            keysym = int(event["keysym"])
            state = int(event["state"])
            if state not in (0, 1):
                raise ValueError("keyboard keysym state must be 0 or 1")
            self.remote.NotifyKeyboardKeysym(
                dbus.ObjectPath(session), options, dbus.Int32(keysym), dbus.UInt32(state)
            )

    def type_text(self, text: str) -> None:
        session = self._session()
        options = dbus.Dictionary({}, signature="sv")
        for character in text:
            keysym = self._keysym(character)
            self.remote.NotifyKeyboardKeysym(
                dbus.ObjectPath(session), options, dbus.Int32(keysym), dbus.UInt32(1)
            )
            self.remote.NotifyKeyboardKeysym(
                dbus.ObjectPath(session), options, dbus.Int32(keysym), dbus.UInt32(0)
            )

    def close_session(self) -> None:
        handle = self.session_handle
        self.session_handle = None
        self.granted_devices = 0
        self.streams = []
        if not handle:
            return
        try:
            session_object = self.bus.get_object(PORTAL_BUS, handle)
            dbus.Interface(session_object, SESSION_IFACE).Close()
        except Exception:
            pass

    def _session(self) -> str:
        self.ensure_session()
        if self.session_handle is None:
            raise RuntimeError("RemoteDesktop portal session is unavailable")
        return self.session_handle

    def _request(self, method, positional: list, options: dict) -> dict:
        handle_token = str(options.get("handle_token") or "")
        if not handle_token:
            raise RuntimeError("portal request handle token is missing")
        sender = self.bus.get_unique_name().lstrip(":").replace(".", "_")
        request_path = f"/org/freedesktop/portal/desktop/request/{sender}/{handle_token}"
        loop = GLib.MainLoop()
        response: dict = {}
        completed = False

        def on_response(code, results):
            nonlocal completed, response
            completed = True
            response = {"code": int(code), "results": _json_safe(results)}
            loop.quit()

        self.bus.add_signal_receiver(
            on_response,
            signal_name="Response",
            dbus_interface=REQUEST_IFACE,
            path=request_path,
        )

        timed_out = False

        def on_timeout():
            nonlocal timed_out
            timed_out = True
            loop.quit()
            return False

        timeout_source = GLib.timeout_add(REQUEST_TIMEOUT_MS, on_timeout)
        try:
            method(*positional, dbus.Dictionary(options, signature="sv"))
            if not completed:
                loop.run()
        finally:
            if not timed_out:
                GLib.source_remove(timeout_source)
            self.bus.remove_signal_receiver(
                on_response,
                signal_name="Response",
                dbus_interface=REQUEST_IFACE,
                path=request_path,
            )

        if timed_out:
            raise TimeoutError("RemoteDesktop portal request timed out")
        code = int(response.get("code", -1))
        if code != 0:
            if code == 1:
                raise PermissionError("RemoteDesktop portal request was cancelled or denied")
            raise RuntimeError(f"RemoteDesktop portal request failed with response code {code}")
        results = response.get("results")
        return results if isinstance(results, dict) else {}

    @staticmethod
    def _keysym(character: str) -> int:
        if character == "\n":
            return 0xFF0D
        if character == "\t":
            return 0xFF09
        if character == "\b":
            return 0xFF08
        codepoint = ord(character)
        if codepoint <= 0xFF:
            return codepoint
        return 0x01000000 | codepoint

    @staticmethod
    def _token(prefix: str) -> str:
        return f"sn_{prefix}_{uuid.uuid4().hex}"


def respond(request_id, *, result=None, error=None) -> None:
    payload = {"id": request_id, "ok": error is None}
    if error is None:
        payload["result"] = result
    else:
        payload["error"] = error
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    portal = RemoteDesktopPortal()
    try:
        for raw in sys.stdin:
            if len(raw.encode("utf-8")) > 256 * 1024:
                continue
            message = None
            try:
                message = json.loads(raw)
                request_id = message.get("id")
                operation = message.get("op")
                if not isinstance(request_id, int) or not isinstance(operation, str):
                    raise ValueError("invalid helper request")
                if operation == "probe":
                    result = portal.probe()
                elif operation == "ensure_session":
                    restore_token = message.get("restoreToken")
                    if restore_token is not None and (not isinstance(restore_token, str) or len(restore_token) > 32 * 1024):
                        raise ValueError("invalid restore token")
                    persist_mode = int(message.get("persistMode", 2))
                    result = portal.ensure_session(restore_token, persist_mode)
                elif operation == "pointer_motion":
                    portal.pointer_motion(float(message["dx"]), float(message["dy"]))
                    result = {"sent": True}
                elif operation == "pointer_motion_absolute":
                    portal.pointer_motion_absolute(
                        int(message["stream"]),
                        float(message["x"]),
                        float(message["y"]),
                    )
                    result = {"sent": True}
                elif operation == "click_left":
                    portal.click_left()
                    result = {"sent": True}
                elif operation == "key_sequence":
                    events = message.get("events")
                    if not isinstance(events, list) or len(events) > 32:
                        raise ValueError("invalid key sequence")
                    portal.key_sequence(events)
                    result = {"sent": True}
                elif operation == "keysym_sequence":
                    events = message.get("events")
                    if not isinstance(events, list) or len(events) > 32:
                        raise ValueError("invalid keysym sequence")
                    portal.keysym_sequence(events)
                    result = {"sent": True}
                elif operation == "type_text":
                    text = message.get("text")
                    if not isinstance(text, str) or len(text.encode("utf-8")) > 16 * 1024:
                        raise ValueError("invalid text payload")
                    portal.type_text(text)
                    result = {"sent": True}
                elif operation == "close":
                    portal.close_session()
                    result = {"closed": True}
                elif operation == "shutdown":
                    portal.close_session()
                    respond(request_id, result={"closed": True})
                    return 0
                else:
                    raise ValueError(f"unknown helper operation: {operation}")
                respond(request_id, result=result)
            except Exception as error:
                request_id = message.get("id") if isinstance(message, dict) else None
                respond(request_id, error=str(error)[:1024])
    finally:
        portal.close_session()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

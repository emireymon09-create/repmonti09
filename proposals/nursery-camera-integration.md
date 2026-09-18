# Proposal — nursery camera → Frigate → Amelia app

**For the Hub session.** Everything here is Hub-owned (`FAMILY_HUB.md` §2:
NUC/HA automations). The Amelia session wrote it because it consumes the
output at `/api/ingest`; it has not been applied anywhere.

**Assumes:** Reolink E1 Zoom (8MP generation), Frigate 0.14+ on the **NUC**
(not HA Green — OpenVINO is Intel-only), HA Green running Home Assistant.

Replace every `CHANGE_ME`.

---

## 1. Why the streams are split this way

The camera gets **one** connection from go2rtc, and Frigate takes what it
needs from that restream. Without it you end up with three separate
connections to the camera (detect, record, audio) and Reolink drops
streams under that load.

- **detect** ← substream, H.264, small. Cheap to run object detection on.
- **record** ← main stream, 4K. Only written to disk, never decoded for
  detection.
- **audio** ← main stream, because that is where the mic lives.

At 8MP the Reolink main stream is often H.265, which is exactly where
Reolink gets flaky. Detection never touches it, so that stays contained.

---

## 2. Frigate config

```yaml
mqtt:
  enabled: true
  host: CHANGE_ME_HA_IP          # HA Green
  user: CHANGE_ME
  password: CHANGE_ME

detectors:
  ov:
    type: openvino
    device: GPU                   # NUC iGPU. This is why Frigate is not on the Green.

go2rtc:
  streams:
    nursery:
      - rtsp://CHANGE_ME_USER:CHANGE_ME_PASS@CHANGE_ME_CAM_IP:554/Preview_01_main
    nursery_sub:
      - rtsp://CHANGE_ME_USER:CHANGE_ME_PASS@CHANGE_ME_CAM_IP:554/Preview_01_sub

cameras:
  nursery:
    enabled: true

    ffmpeg:
      output_args:
        # Keep audio in the recording, otherwise the mic is detect-only.
        record: preset-record-generic-audio-aac
      inputs:
        - path: rtsp://127.0.0.1:8554/nursery_sub
          input_args: preset-rtsp-restream
          roles: [detect]
        - path: rtsp://127.0.0.1:8554/nursery
          input_args: preset-rtsp-restream
          roles: [record, audio]

    detect:
      enabled: true
      width: 640
      height: 480
      fps: 5                      # a sleeping baby does not need 20fps

    audio:
      enabled: true
      min_volume: 500             # TUNE THIS — see §5
      listen:
        - crying
      num_threads: 2

    objects:
      track:
        - person

    record:
      enabled: true
      retain:
        days: 3
        mode: motion

    snapshots:
      enabled: true               # stays on the NUC; nothing is uploaded

    motion:
      threshold: 30
      contour_area: 15            # small, so breathing-scale movement registers
```

---

## 3. Home Assistant → `/api/ingest`

The one door the house uses to reach the app. Device secret, not a login.

```yaml
# secrets.yaml
amelia_ingest_url: "https://CHANGE_ME_APP_URL/api/ingest"
nuc_device_secret: "CHANGE_ME"   # must equal NUC_DEVICE_SECRET in the app's env
amelia_baby_id: "CHANGE_ME"      # uuid from the babies table
```

```yaml
# configuration.yaml
rest_command:
  amelia_ingest:
    url: !secret amelia_ingest_url
    method: POST
    content_type: "application/json"
    headers:
      x-device-secret: !secret nuc_device_secret
    payload: '{{ body }}'
    timeout: 10
```

---

## 4. The three automations

```yaml
automation:
  # ---------------------------------------------------------------- cry
  - alias: "Amelia — cry detected → monitor_events"
    mode: single
    trigger:
      - platform: mqtt
        topic: "frigate/nursery/audio/crying"
        payload: "ON"
    action:
      - service: rest_command.amelia_ingest
        data:
          body: >-
            {"baby_id": "{{ states('input_text.amelia_baby_id') }}",
             "event_type": "sound_alert",
             "occurred_at": "{{ now().isoformat() }}",
             "meta": {"source": "frigate", "label": "crying", "camera": "nursery"}}
      # 5 minutes of quiet before this can fire again, or a single fussy
      # stretch writes forty rows.
      - delay: "00:05:00"

  # -------------------------------------------------------- sleep start
  - alias: "Amelia — settled → sleep_start"
    mode: single
    trigger:
      - platform: state
        entity_id: binary_sensor.nursery_motion
        to: "off"
        for: "00:10:00"
    condition:
      # don't open a second session on top of an open one
      - condition: state
        entity_id: input_boolean.amelia_asleep
        state: "off"
    action:
      - service: input_boolean.turn_on
        target: {entity_id: input_boolean.amelia_asleep}
      - service: rest_command.amelia_ingest
        data:
          body: >-
            {"baby_id": "{{ states('input_text.amelia_baby_id') }}",
             "kind": "sleep_start",
             "occurred_at": "{{ (now() - timedelta(minutes=10)).isoformat() }}"}
             # backdated: she fell asleep when the motion stopped, not
             # when the timer expired

  # ---------------------------------------------------------- sleep end
  - alias: "Amelia — awake → sleep_end"
    mode: single
    trigger:
      - platform: state
        entity_id: binary_sensor.nursery_motion
        to: "on"
        for: "00:02:00"
      - platform: mqtt
        topic: "frigate/nursery/audio/crying"
        payload: "ON"
    condition:
      - condition: state
        entity_id: input_boolean.amelia_asleep
        state: "on"
    action:
      - service: input_boolean.turn_off
        target: {entity_id: input_boolean.amelia_asleep}
      - service: rest_command.amelia_ingest
        data:
          body: >-
            {"baby_id": "{{ states('input_text.amelia_baby_id') }}",
             "kind": "sleep_end",
             "occurred_at": "{{ now().isoformat() }}"}
```

Helpers needed:

```yaml
input_boolean:
  amelia_asleep:
    name: Amelia asleep
    icon: mdi:sleep

input_text:
  amelia_baby_id:
    name: Amelia baby id
    initial: CHANGE_ME
```

---

## 5. Tuning, honestly

**`min_volume` is the one you will get wrong first.** 500 is a starting
guess. Watch Frigate's logs with audio debug on for a day and set it just
above the room's noise floor — too low and the white-noise machine trips
it, too high and you miss the first minute of crying.

**The sleep heuristic is crude and you should expect to tune it.** Ten
minutes of no motion is a guess at "settled"; a newborn who is awake and
still will read as asleep, and a swaddled baby who barely moves will too.
Two better inputs once the basics work:

- gate `sleep_start` on the room being dark, or on a time window
- require the cry label to be *absent* for the same ten minutes

Do not chase precision here. The app lets you correct a session by hand,
and a roughly-right automatic log beats an exact one nobody enters.

---

## 6. What this does NOT do

- **No retry queue.** If the NUC has no internet, the `rest_command`
  fails and that event is gone. HA does not queue natively. The event is
  still in HA's own history, so nothing is lost locally — this is only
  about the cloud copy. `FAMILY_HUB.md` §3 already tracks this.
- **Still uses the shared `NUC_DEVICE_SECRET`**, not the per-device
  hashed tokens in ADR 0005. Fine for now; nothing else calls the
  endpoint.
- **No video, images or audio leave the house.** Only the derived event
  and its label. `snapshots` are written to the NUC's disk and never
  posted.

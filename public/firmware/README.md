# Firmware for the changing-table screen

The screen (ESP32-S3, `AMELIA SOFTWARE/changer-display/`) reads `changer-display.json` here
every hour and installs a higher `version` by itself: it downloads `bin` over HTTPS, checks
`size` and `md5`, and restarts into it. A version that can't reach the app rolls back.

These files are public on purpose and carry **no secrets**: they are built with an empty
`secrets.h`, and the board keeps Wi-Fi and its device token in its own storage.

To publish: add the new `.bin`, point the manifest at it (version, bin, size, md5), and push
to `main` with the app's usual version bump. Old `.bin` files can be deleted.

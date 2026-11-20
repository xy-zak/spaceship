# Firmware plan (ESP32 panel)

> Written by the microcontroller planning agent. Where this conflicts with [README.md](README.md), the README wins. The review needed no changes to this plan; the browser adopted the reset handshake, the marker gate and the 4096-byte buffer this plan asked for.

## 1. Summary

- **Toolchain:** one Arduino sketch in `firmware/panel/`, built and flashed with arduino-cli 1.6.0. A `sketch.yaml` profile pins Arduino-ESP32 3.3.13. No third-party libraries.
- **Endless:** an interrupt routine decodes the encoders with a 16-entry quadrature table. **Trigger and Hold:** a 10 ms debounce.
- **Capped:** each reading is the mean of 16 ADC samples, then smoothed, then mapped through calibrated end dead zones (the end snap). A value is sent only after a move of ≥20, except that exactly 0 and 1000 are always sent.
- **Output timing:** endless and capped lines go out on a 20 ms report tick, at most 50 lines/s per control. `select`, `box`, `reroll` and `ok` are sent at once. The only other output is `#` comment lines.
- **Identical firmware on all three stations.** Pins and calibration live in one table in `config.h`; adding a steering channel means adding two rows.
- **Corrections to the agreed plan:**
  - WROOM-32 boards wire out only 6 ADC1 pins, not 8.
  - The board doesn't always reset when the port opens, so the browser resets it itself.

## 2. What exists in the repo

No firmware yet: no `.ino`, `.cpp`, `.h` or `platformio.ini` files, and nothing mentions serial, ESP32 or Arduino.

A new `firmware/` folder doesn't touch the web build: `tsconfig.json` includes only `src`, and `vite.config.ts` builds only the HTML pages. Prettier formats the `.mjs` and `.md` files under `firmware/` and skips `.ino` and `.h`.

The firmware follows AGENTS.md's spirit: plain structs and free functions, no classes. The host-side checker follows the pattern of the dependency-free Node scripts in `scripts/`.

## 3. What to add

```
firmware/
  README.md          install, flash, calibrate, wiring and BOM, troubleshooting (the one doc a builder needs)
  check-lines.mjs    host-side checker: reads serial lines on stdin and checks them against the contract
  panel/
    sketch.yaml      pinned core, board options (FQBN), default port
    config.h         pin tables and calibration: the only file a builder edits
    panel.ino        types, the encoder ISR, debounce, hold, capped filter, printing, setup/loop
```

**Contract values** (fixed in `panel.ino`, not edited per station):

```cpp
const uint32_t REPORT_MS = 20, DEBOUNCE_MS = 10, HOLD_MS = 1000;
const int MIN_MOVE = 20, ADC_SAMPLES = 16;
const float SMOOTHING = 0.5;  // the 16-sample mean already gives about ±1 unit; this only damps rare spikes

struct Endless { const char* name; uint8_t pinA, pinB; int countsPerStep; volatile int32_t count; volatile uint8_t prev; int32_t taken; };
struct Button  { const char* name; uint8_t pin; bool raw, pressed, fired; uint32_t changedAt, pressedAt; };
struct Capped  { const char* name; uint8_t channel, pin; int rawAt0, rawAt1000; float filtered; int sent, rawMin, rawMax; };

void IRAM_ATTR onQuadratureEdge(void* endless);  // QUAD[prev<<2|now] adds +1, -1, or 0 for bounce
int  takeSteps(Endless& e);                       // whole steps since the last call; the remainder stays in count
bool pressEdge(Button& b, uint32_t now);          // true once, after the pin has been stable for 10 ms
void updateHold(Button& b, uint32_t now);         // prints ok after 1 s held; drives the LED
int  readRaw(uint8_t pin);                        // mean of 16 analogRead samples
int  toPosition(const Capped& c);                 // filtered raw value -> 0..1000, clamped
bool shouldSend(int position, int sent);
void reportCapped(Capped& c);                     // sample, filter, print if shouldSend
```

**The logic that carries the contract:**

```cpp
const int8_t QUAD[16] = {0,-1,1,0, 1,0,0,-1, -1,0,0,1, 0,1,-1,0};
int32_t steps = (e.count - e.taken) / e.countsPerStep;  // truncates toward 0: jiggling inside a detent sends nothing
float p = (c.filtered - c.rawAt0) * 1000 / (c.rawAt1000 - c.rawAt0);
return constrain(lroundf(p), 0, 1000);                  // past either calibrated end it clamps: the end snap
return position != sent && (abs(position - sent) >= MIN_MOVE || position == 0 || position == 1000);
```

**`config.h`** (one table per action type; the row order sets the order of the boot dump):

```cpp
#define CALIBRATE 0  // 1: also print "# cal value 1 raw=… min=… max=…" every 500 ms
Endless endless[] = {{"scrub",16,17,4}, {"across",18,19,4}, {"down",21,22,4}};  // turns the wrong way: swap A and B
Button triggers[] = {{"select",23}, {"box",4}, {"reroll",13}};
Button ok = {"ok",27};  const uint8_t OK_LED = 14;
Capped capped[] = {     // name, channel, ADC pin, raw at the 0 end, raw at the 1000 end (reversed control: swap the two)
  {"value",1,36,100,3995}, {"strength",1,39,100,3995},
  {"value",2,34,100,3995}, {"strength",2,35,100,3995}};
```

Each control stores "raw at the 0 end" and "raw at the 1000 end", so reversing a control means swapping two numbers. No invert flag is needed.

**`setup()`**

1. `Serial.begin(115200)`.
2. Attach the encoder ISR to both A and B pins with `CHANGE`, and record each encoder's starting state.
3. Set buttons to `INPUT_PULLUP` and read their current state, so a button held at boot fires nothing. For the hold button, set `fired = pressed`, so it must be released first.
4. Start each capped filter with one full reading (no warm-up ramp) and set `sent` to that position.
5. Print an empty line, so the marker never joins leftover boot bytes.
6. Print `# spaceship-panel 1`.
7. Print every capped row in table order.

**`loop()`**

- Check the triggers, then update the hold button.
- When `now - lastReport >= 20`: set `lastReport = now`, print non-zero encoder steps, then run each capped control.
- `delay(1)` at the end.

**Output:** every line is one `Serial.printf("…\r\n")` call. No `String`, and no heap use in `loop()`.

**Hold LED:** `analogWrite(OK_LED, 255·p²)` while held, where p is the fraction of 1 s held. Full on after `ok` until release; off at once on an early release.

## 4. Toolchain and libraries

- **arduino-cli 1.6.0.** One static binary, using the same core as Arduino IDE 2, so `panel/` also opens in the IDE. Install with:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=~/.local/bin sh -s 1.6.0
  ```

- **Core pinned in `sketch.yaml`.** The first compile installs it automatically into a separate cache:

  ```yaml
  profiles:
    panel:
      fqbn: esp32:esp32:esp32:DebugLevel=none,UploadSpeed=460800
      platforms:
        - platform: esp32:esp32 (3.3.13)
          platform_index_url: https://espressif.github.io/arduino-esp32/package_esp32_index.json
  default_profile: panel
  default_port: /dev/ttyUSB0
  ```

  - `DebugLevel=none` keeps core log lines off the wire.
  - `UploadSpeed=460800` because CH340 boards often fail at the default 921600.
  - Build and flash with `arduino-cli compile --upload --warnings all` from `firmware/panel`.

- **Why 3.3.13, not 4.0.0:** 4.0.0 came out on 19 Nov 2026 and moves to ESP-IDF 6.1.1. The sketch uses only `analogRead`, `analogWrite`, `attachInterruptArg` and `Serial`, so upgrading later is a one-line change followed by the test checklist.

- **Rejected:**
  - PlatformIO: its official espressif32 platform still lacks Arduino-ESP32 3.x.
  - ESP-IDF: CMake, menuconfig and a Python environment are too much for a student, and nothing here needs it.
  - ESP32Encoder: the table ISR is about 15 lines and easily handles hand-turned encoders. If a high-resolution wheel ever loses steps, switch to its `attachFullQuad`, used only inside `takeSteps`.
  - Bounce2: replaced by 10 lines of own code.
  - `analogReadMilliVolts`: plain 12-bit `analogRead` at 11 dB attenuation is enough, because both ends are calibrated per control.

## 5. Architecture rules

1. The firmware only writes. It never reads serial and never waits on the host.
2. Plain structs and functions only: no classes, no heap use after `setup()`, no `String`.
3. All timing uses `now - since >= interval` with `uint32_t`, so the millis rollover is harmless.
4. Only the ISR writes `count`; the loop only reads it. Both run on core 1, and 32-bit reads are atomic.
5. Nothing reaches the wire except grammar lines and `#` lines.
6. `config.h` is the only file that changes per panel. Contract constants stay in `panel.ino`.

## 6. Serial interface

The grammar, boot sequence and handshake are in the README.

**Firmware specifics**

- 115200 baud, 8N1, no flow control. Every line ends in `\r\n`, and data lines are at most 17 characters.
- Each endless or capped control sends at most one line per 20 ms. Triggers send one line per debounced press, `ok` one per hold.
- The reference panel peaks at about 100 bytes per 20 ms, roughly 45% of the link, so the 128-byte UART buffer never overflows.
- With nobody reading, the UART keeps sending and nothing blocks.
- The ROM boot messages can't be reliably silenced (grounding GPIO15 is meant to do it, but reports conflict). Crash or brown-out text can appear at any time, followed by a fresh boot sequence.
- Because of the ≥20 rule, a capped control at rest can sit up to 19 units from the last value sent.
- Endless lines are at least 20 ms apart, so the size of a step count reflects turning speed. The browser can use it for acceleration.

## 7. Assumptions about the browser

All matched by `client.md` after the review (README #7–#10):

- It opens with `bufferSize: 4096`.
- It resets the board right after opening, and never leaves DTR on with RTS off.
- It strips `\r`, ignores lines outside the grammar, and drops lines until the marker or for 2 s.
- It handles a boot dump at any time.
- Positive steps mean forward, the next word, and the line below.
- It reopens the port on the `connect` event.

## 8. Reference panel

**Pin map (ESP32-WROOM-32 DevKit)**

| Function                        | GPIO                                                              | Notes                                           |
| ------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| scrub A/B                       | 16 / 17                                                           | not on WROVER boards, which use these for PSRAM |
| across A/B                      | 18 / 19                                                           |                                                 |
| down A/B                        | 21 / 22                                                           |                                                 |
| select (across encoder's press) | 23                                                                | internal pull-up                                |
| box / reroll                    | 4 / 13                                                            | internal pull-up                                |
| ok (hold)                       | 27                                                                | internal pull-up                                |
| ok LED                          | 14                                                                | flickers briefly at boot, harmless on an output |
| ch1 value / strength            | 36 / 39                                                           | ADC1; fine for analog                           |
| ch2 value / strength            | 34 / 35                                                           | ADC1; input-only, pots need no pull-ups         |
| spare ch3                       | 32 / 33                                                           | ADC1                                            |
| spare ch4                       | 25 / 26                                                           | ADC2; works only because Wi-Fi is off           |
| never use                       | 0, 2, 5, 12, 15 (strapping); 1, 3 (the serial link); 6–11 (flash) | GPIO37/38 are not wired out on WROOM-32         |

**Wiring per action type**

- **Endless:** common pin to GND. A and B each get 10 kΩ to 3V3 and 10 nF to GND. A KY-040 module already has the pull-ups; power its `+` from **3V3, never 5V**.
- **Trigger and Hold:** one leg to GND, the other to the GPIO. Add 100 nF at the pin for wires over 30 cm. On a metal panel the public touches, add 1 kΩ in series at the board against static discharge.
- **Capped:** pot ends to 3V3 and GND, with **GND at the 0 end**, and the wiper to the ADC pin. At the board, add 100 nF and 1 MΩ from the wiper to GND, so a broken wire reads a steady 0 instead of drifting. Never connect 5V.
- **LED:** GPIO14 → 330 Ω → LED → GND, about 4 mA. For a 5 V lit button, switch it with an NPN transistor on the low side, fed from the board's 5V pin, with 1 kΩ on the base.
- **Power:** one good USB _data_ cable from the Pi; charge-only cables are a common cause of "port not found". The panel draws under 100 mA. Bring all grounds to one point at the board's GND.

**Bill of materials per station**

| Type    | Qty                    | Part                                                                    | Extras                                        |
| ------- | ---------------------- | ----------------------------------------------------------------------- | --------------------------------------------- |
| Endless | 3                      | EC11 encoder, 20 detents / 20 pulses; the across one with a push switch | 2× 10 kΩ and 2× 10 nF each, knob              |
| Trigger | 2 (+ the across press) | 24–30 mm momentary arcade button                                        | 100 nF (optional)                             |
| Hold    | 1                      | 30 mm momentary arcade button                                           | 5 mm LED, 330 Ω                               |
| Capped  | 4                      | 60 mm linear B10K slide pot, dust-proof                                 | 100 nF and 1 MΩ each                          |
| Board   | 1                      | WROOM-32 DevKit with CP2102 or CH340                                    | USB data cable ≤ 1 m, screw-terminal breakout |

**Encoder scaling:** set `countsPerStep` to 4 for 20/20 EC11 encoders, and 2 for encoders with half a cycle per detent. For detentless jog wheels, pick by feel.

**Adding steering channels:** add two rows to `capped`, ch3 on 32/33 and ch4 on 25/26; no code changes. More than 4 channels would need an analog multiplexer such as a CD74HC4067, which isn't planned.

## 9. Edge cases and failure handling

- **Button held through a reset:** sends nothing until released and pressed again.
- **Button stuck pressed:** sends one event. A cut wire reads "not pressed". A cut encoder wire stops its counts.
- **Long uptime:** wrap-safe arithmetic throughout (`millis` rolls over at 49.7 days), and no heap use in the loop.
- **Brown-out:** keep the brown-out detector on. It resets cleanly, and the boot dump re-syncs the page. Use the official 5.1 V 3 A supply for the Pi.
- **Unplug and replug:** the board power-cycles; the browser reopens the port and resets the board.
- **More than 4 channels:** add `Serial.setTxBufferSize(1024)` before `begin`.
- **Scratchy or worn pots:** the main failure to expect in the field. The 100 nF capacitor rides through short dropouts; buy dust-proof pots.

## 10. Test and verification plan

1. **Build:** `arduino-cli compile --warnings all` passes with no warnings.
2. **Boot output:** run `arduino-cli monitor --config baudrate=115200` and press EN. Expect the boot messages, an empty line, the marker, then 4 dump lines that match the sliders.
3. **Checker:** `stty -F /dev/ttyUSB0 115200 raw -echo; node firmware/check-lines.mjs < /dev/ttyUSB0`. It echoes each line with the time since the last one, and prints `!` before any line that breaks the grammar, the ≥20/end rule or the 20 ms spacing.
4. **Endless:**
   - one detent sends exactly ±1;
   - one full turn sums to 20;
   - ten fast turns lose no steps;
   - jiggling inside a detent sends nothing.
5. **Trigger:**
   - 50 presses give 50 lines;
   - slow presses give no doubles;
   - holding for 5 s gives one line.
6. **Hold:**
   - releasing at 0.5 s sends nothing and turns the LED off;
   - 1 s sends one `ok`, and the LED stays full until release;
   - 10 s still sends one `ok`.
7. **Capped:**
   - creeping into either end, the last line is exactly 0 or 1000;
   - slow moves send steps of ≥20;
   - a fast slide sends at most 50 lines/s;
   - **key test:** everything left still for 10 minutes, with the speakers playing, sends zero lines.
8. **Robustness:** 20 page loads on the Pi each sync the panel; unplug and replug mid-session; run 24 h with the checker logging.
9. **Calibration:**
   1. Set `CALIBRATE 1`, flash, and sweep each control end to end.
   2. Set `rawAt0 = min + 100` and `rawAt1000 = max − 100` (swap them if the 0 end reads high).
   3. Set `CALIBRATE 0`, flash, and repeat step 7.

   The defaults of 100 and 3995 usually pass unchanged.

## 11. Open questions and risks

- **Unverified:** whether CP2102 and CH340 bridges keep stale bytes while the port is closed. The browser's marker gate covers it either way.
- **Board type:** buy WROOM boards, not WROVER.
- **Flashing cheap boards:** some need BOOT held during "Connecting…". Check whether `brltty` grabs CH340 boards on Raspberry Pi OS.
- **Untested:** none of this has run on hardware. The reset sequence, the boot timing and the dead-zone defaults need checking on a real board.

Sources: [arduino-esp32 releases](https://github.com/espressif/arduino-esp32/releases), [arduino-cli releases](https://github.com/arduino/arduino-cli/releases), [sketch project file](https://docs.arduino.cc/arduino-cli/sketch-project-file), [esptool boot mode selection](https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/boot-mode-selection.html), [ESP32 errata GPIO36/39](https://docs.espressif.com/projects/esp-chip-errata/en/latest/esp32/03-errata-description/esp32/gpio-inputs-pulled-down.html), [MDN setSignals](https://developer.mozilla.org/docs/Web/API/SerialPort/setSignals), [esptool-js reset.ts](https://github.com/espressif/esptool-js/blob/main/src/reset.ts).

# RPM — Turntable Speed & Accuracy

A turntable speed tester for the iPhone, built as an installable web app. Put the phone on the
platter, start the deck, and it reports what the platter is actually doing: average speed, how far
that is from 33⅓ / 45 / 78 / 16⅔, wow and flutter, and where in the rotation the error lives.

It does the same job as the App Store app of the same name, using the same physical principle —
the phone's gyroscope — and needs no App Store account, no network, and no data leaves the phone.

<!-- ------------------------------------------------------------------ -->

## Getting it onto the iPhone

The one requirement is that the page is served over **https** — iOS refuses motion sensors otherwise.

### Option A — GitHub Pages (one switch, no tooling)

1. Repository ▸ **Settings ▸ Pages ▸ Source: GitHub Actions**. This has to be done by hand once:
   the Actions token is not allowed to create a Pages site, so the first deploy fails with
   *"Resource not accessible by integration"* until the switch is flipped. (On a **private**
   repository Pages also needs a paid GitHub plan — if that is in the way, use Option B.)
2. Actions ▸ **Deploy to GitHub Pages** ▸ **Run workflow**, or just push again. Every push to
   `main` or to the development branch publishes, and the run prints the URL — normally
   `https://dinocode00.github.io/Rpm-speed-app/`.
3. Open that URL in **Safari** on the iPhone, then **Share ▸ Add to Home Screen**.

### Option B — any static host

Every file is static. Drop the repository root on Netlify, Vercel, Cloudflare Pages, or your own
web server. There is nothing to build.

### Then, on the phone

Launch it from the Home Screen icon and press **Start**; iOS asks once for motion access. If you
decline by accident: **Settings ▸ Apps ▸ Safari ▸ Motion & Orientation Access**, then reload.

After the first launch it is cached and runs with the phone in Airplane Mode.

<!-- ------------------------------------------------------------------ -->

## Using it

1. Put a record on the platter, so the phone lies on vinyl rather than on bare metal or a ribbed mat.
2. **Zero sensor** — two seconds with the phone still, on the stopped platter. This removes the
   gyroscope's standing bias, which is the largest error in a cheap MEMS sensor, and measures the
   noise floor so you know which readings are the deck and which are the phone.
3. **Start**, lay the phone flat near the spindle, start the turntable.
4. Leave it a minute or more. Wow and flutter need revolutions before they mean anything.
5. Stop the platter — the reading freezes. **Save run** files it in History.

Placement does not matter. A gyroscope measures the angular velocity of the whole rigid body, so
anywhere on the record reads identically, centred or not. What matters is that the phone lies flat
and cannot creep.

## What the readouts mean

| Readout | Meaning |
|---|---|
| **Average** | Total angle turned ÷ total time. This is the figure to trust. |
| **%** | Error against the target speed. Within ±0.3% is a healthy belt drive; a good direct drive holds ±0.1%. |
| **Cents** | The same error expressed as musical pitch. ~17 cents is about the smallest shift most listeners hear on a sustained note; 0.5% ≈ 9 cents. |
| **W&F peak / RMS** | Largest and typical departure from the run's own average, after smoothing. |
| **Min / max** | The extremes of the smoothed speed. |
| **Once per rev** | The size of the error component that repeats exactly once per revolution — a worn belt joint, an eccentric pulley, motor cogging. The **Platter map** tab shows where in the turn it happens. |
| **Drift / 20 min side** | How early or late a 20-minute record side would finish at this speed. |

## Settings worth knowing

- **Smoothing window** — the moving average behind the graph and the W&F figures. Short windows
  see faster wow but carry more sensor noise; long windows are quiet but flatten real wavering.
- **Settling time** — seconds ignored while the platter comes up to speed, so spin-up never drags
  the average down.
- **Stop automatically after** — ends the run at a fixed length of measured time and freezes the
  reading, so repeat measurements cover the same span and are worth comparing. Off by default.
- **Counter-rotate the display** — turns the readout against the platter so the numbers stay
  upright and readable while the phone spins.
- **Gyroscope scale calibration** — optional. Runs the magnetometer alongside the gyroscope, counts
  real revolutions by compass heading, and corrects any scale error in the gyroscope. Do it once,
  away from speakers and the motor; it refuses to apply a correction bigger than 5%, which is
  magnetic interference rather than a sensor fault.

## Accuracy, honestly

- **Average speed is the strong measurement.** It comes from integrating angle over the whole run,
  so short-term noise averages out; over a minute it is good to a few thousandths of an RPM.
  Verified against synthetic input: 33.400 RPM in, 33.4000 RPM out.
- **Wow & flutter is a wow measurement.** iOS delivers about 60 gyroscope samples a second, so
  nothing wavering faster than ~30 Hz can be seen at all — that is the flutter end of the band a
  3,150 Hz test record measures. The figures here are unweighted (no DIN/IEC filter), so they are
  not comparable with a manufacturer's spec sheet. They are excellent for comparing one deck, belt,
  or bearing against another.
- **The phone is a real part of the measurement.** Zero it every session; the noise floor printed
  under the buttons is the smallest W&F figure that means anything on your hardware.

## Layout

```
index.html          markup
guide.html          the in-app guide: how to use it, how to read the numbers, fault diagnosis
app.css             styling
js/engine.js        the measurement: bias removal, axis tracking, angle integration, statistics
js/sensors.js       DeviceMotion / DeviceOrientation access, permissions, wake lock, simulator
js/charts.js        scrolling speed graph and the polar platter map
js/store.js         settings and saved runs (localStorage)
js/app.js           UI wiring
sw.js               offline cache
tools/make_icons.py regenerates the icons
```

### How the engine works

The gyroscope reports rotation about three device axes. The engine subtracts the bias captured by
**Zero sensor**, accumulates the mean rotation vector to find the platter's axis (so a phone that
is slightly tilted, or propped on a mat, still reads correctly), and projects each sample onto that
axis. Cross-axis noise averages away and the result keeps its sign.

Angle is integrated with the trapezoid rule against real timestamps, and the average speed is that
angle divided by the time actually sampled — not by wall-clock time, so a backgrounded tab leaves
a gap rather than a falsely slow reading. Instantaneous speed is binned by rotational phase for the
platter map, and a first-harmonic fit over the same data gives the once-per-revolution figure.

### Simulator

Append `?sim` to the URL for a synthetic turntable — handy on a desktop, and what the smoke test
drives:

```
?sim=33.31&wow=0.4&noise=0.8      # RPM, wow amplitude %, gyro noise °/s
```

## Differences from the App Store app

Feature-for-feature apart from three things: there is no shared "world database" of submissions,
history stays on the device instead of syncing, and the App Store app's flutter figures come from
the same 60 Hz sensor, so treat any cross-app comparison of W&F as indicative rather than exact.

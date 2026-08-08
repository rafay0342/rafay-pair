# Speech gate

Normative for every RafayPair client that streams audio to the assistant.
Golden vectors live in `tests/golden/speech-gate`.

## What it is for

A voice session should answer the person holding the phone and ignore the rest
of the world — a television, a conversation across the room, someone else
talking nearby. The provider's own voice-activity detection decides when a turn
ends; it does not decide _whose_ turn it is, and it hears whatever we send it.

So the decision of what to send is made on the device, before anything leaves
it. That placement is deliberate: audio the gate rejects is never transmitted at
all, which is a stronger statement than transmitting it and asking a server to
disregard it.

## What it is not

This is **near-field gating**, not speaker identification. It distinguishes
_close_ from _far_, not _this person_ from _that person_. Someone else speaking
directly into the same phone will pass it.

Calling it identity would be a lie a user could be harmed by — they would rely
on a guarantee that does not exist. The interface says "closer voices only", and
this file says why.

## The signal

For each 20 ms frame of 16 kHz mono PCM16, the gate computes short-term energy
as root-mean-square amplitude normalised to `0...1`.

Speech near a phone microphone sits far above room noise: an arm's length away
is typically 25–35 dB above a quiet room's floor, and a television across a room
arrives 10–20 dB below that. The gate is placed inside that gap rather than at a
fixed level, because a fixed level would be wrong in both a silent bedroom and a
noisy kitchen.

## The noise floor

The floor tracks the quietest recent frames, and it tracks **downwards quickly
and upwards slowly**:

```text
if frameRms < floor:  floor += (frameRms - floor) * FLOOR_FALL
else:                 floor += (frameRms - floor) * FLOOR_RISE
```

```text
FLOOR_FALL = 0.20    a room that goes quiet is recognised within a few frames
FLOOR_RISE = 0.002   a room that gets louder is adopted over tens of seconds
```

The asymmetry is the whole point. A floor that rose quickly would climb during
speech until the speaker's own voice no longer cleared it, and the gate would
close mid-sentence. Rising slowly means sustained noise is eventually accepted
as the new floor, while a burst of speech never is.

`FLOOR_MINIMUM = 0.0008` stops the floor from collapsing to zero in digital
silence, which would otherwise make the first faint sound afterwards look like a
shout.

## Opening and closing

```text
OPEN_RATIO  = 6.0    frame must be ~15.6 dB above the floor to open
CLOSE_RATIO = 3.0    it stays open until ~9.5 dB above the floor
NEAR_MINIMUM = 0.010 an absolute floor, so nothing distant opens it in silence
HANGOVER_FRAMES = 12 240 ms of grace before it closes
```

Two thresholds rather than one, because a single threshold chatters: a voice
hovering at the boundary would open and close the gate every few frames and
chop the sentence into fragments. Opening is harder than staying open, which is
how a human listener works too.

`NEAR_MINIMUM` is what a ratio alone cannot express. In a very quiet room the
floor becomes tiny, and distant speech clears `OPEN_RATIO` easily while still
being distant. An absolute minimum says: quiet or not, this has to be close.

`HANGOVER_FRAMES` carries the gate through the pauses inside a sentence.
Without it, the gaps between words would close it and the provider would hear
speech chopped into pieces — which is heard, at the other end, as an assistant
that interrupts constantly.

## Output

```text
GateDecision = { transmit: bool, open: bool, rms: number, floor: number }
```

`transmit` is what the caller acts on. `open`, `rms`, and `floor` are reported
so an interface can show why the gate is behaving as it is, rather than leaving
a user to guess why they are not being heard.

## What callers must do

- Feed **every** frame, including those they do not transmit. The floor is only
  correct if it has seen the room.
- Transmit only frames where `transmit` is true.
- Never use this as a reason to stop capturing. The microphone indicator must
  reflect that the microphone is on, whatever the gate is doing with the frames.

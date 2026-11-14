# PROTOTYPE: the bolder board (throwaway, never merge)

Question: how bold can the Squadron board get in its own dithered-pixel world while staying readable and useful?

Open `comps/bolder-board/index.html` in any browser as a file. One self-contained file: no network and no build step. The dither engine and the 5x7 pixel font are ports of `lib/dither.ts` and `lib/pixels.ts`. All data is synthetic.

- **Variant:** the floating bar at the bottom, the ← → keys or `?variant=A|B`.
  - **A · Tall sky:** a 216px banner of open sky. The formation flies a V across it, and SQUADRON sits in a clear corner of the sky.
  - **B · Runway:** a 164px banner. The planes stand in a row on a runway and take off from it, and SQUADRON is stencilled on the tarmac.
- **Theme** (dark, light), **Width** (full page, side panel at 560px, both) and **Motion** (live, reduced) sit in the top bar.
- **Simulate:** Start, Needs you, Stop, Ticket to branch, Agent +1, Land, Empty and Reset. The line under the bar shows the resulting state. The fly-past plays once, when the last Ready spec lands: press Start twice, then Land four times.
- The URL keeps your choices. `?sim=start,stop` runs simulate steps on load.

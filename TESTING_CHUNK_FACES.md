# Testing Guide: Chunk Boundary Face Rendering Fix

## Issue
Missing block faces at the edge of chunks when placing or breaking blocks.

## How to Test

### Setup
1. Start the server: `node server.js`
2. Open browser to `http://localhost:7883/`
3. Click "Resume" to enter the game
4. Press `F3` to show debug info (optional but helpful)

### Test Case 1: Visual Inspection at Chunk Boundaries
**Goal:** Verify that blocks at chunk edges have all visible faces rendered

**Steps:**
1. Wait for initial chunks to load (watch debug info: "Loaded: X")
2. Note your current chunk coordinates (visible in debug info)
3. Calculate chunk boundary:
   - Each chunk is 16x16 blocks
   - If you're at chunk (128, 128), the boundaries are at world coordinates:
     - X: 128*16 = 2048 (west edge) to 129*16-1 = 2063 (east edge)
     - Z: 128*16 = 2048 (south edge) to 129*16-1 = 2063 (north edge)

4. Move to a chunk boundary location
5. Look at blocks along the chunk edge
6. **Expected:** All visible faces of blocks should be rendered with no gaps

### Test Case 2: Place Blocks at Chunk Edge
**Goal:** Verify that placing a block at a chunk boundary renders all its visible faces

**Steps:**
1. Fly to a known chunk boundary (e.g., X=2064, Z=2048)
2. Right-click to place a dirt block
3. Look at the block from all angles
4. **Expected:** All 6 faces should be visible (no missing faces)

### Test Case 3: Break Blocks at Chunk Edge
**Goal:** Verify that breaking a block at a chunk boundary updates faces correctly

**Steps:**
1. Find an existing block at a chunk boundary
2. Left-click to break it
3. Observe neighboring blocks
4. **Expected:** Faces of neighboring blocks that are now exposed should become visible

### Test Case 4: Chunk Loading Order
**Goal:** Verify faces appear correctly regardless of which chunk loads first

**Steps:**
1. Exit to menu and reload the world
2. As chunks load, watch for any visual gaps appearing/disappearing
3. Move around to trigger new chunk loading
4. **Expected:** No flickering or missing faces should appear as chunks load

## What Was Fixed

### Before the Fix
- When a chunk boundary had no neighboring chunk loaded, faces were hidden
- Even after the neighbor loaded, faces remained hidden
- Result: Permanent visual gaps at chunk edges

### After the Fix  
- Chunk boundary faces now assume AIR (empty space) when neighbor not loaded
- Faces are visible by default at boundaries
- When neighbor loads, face culling logic properly determines visibility
- Result: No visual gaps, correct rendering at all times

## Performance Notes
- The fix has negligible performance impact
- A few extra faces may be rendered temporarily until neighbor chunks load
- This is preferable to visual glitches and missing geometry
- Modern GPUs handle this overhead easily

## Expected Behavior

### ✅ Correct (After Fix)
```
Chunk A boundary          Chunk B boundary
     |                           |
  [Block]---visible face---[Air/Unloaded]
     |                           |
```
Face is VISIBLE because it's exposed to air/unloaded space

### ❌ Incorrect (Before Fix)
```
Chunk A boundary          Chunk B boundary
     |                           |
  [Block]---HIDDEN face----[Air/Unloaded]
     |                           |
```
Face was HIDDEN incorrectly, creating visual gap

## Debug Tips
- Press `F3` to toggle debug information
- Debug info shows:
  - Current chunk coordinates
  - Number of loaded chunks
  - World position
  - What block you're looking at
- Use this to navigate to specific chunk boundaries for testing

## Automated Testing (Future)
Currently there is no automated test infrastructure. Future improvements could include:
1. Unit tests for `shouldCullFace()` function in both workers
2. Visual regression tests comparing chunk boundary rendering
3. Performance benchmarks to ensure no regression
4. Integration tests that simulate chunk loading patterns

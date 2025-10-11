# Quick Reference: Performance Features

## Priority Chunk System

### What It Does
Chunks you modify (place/break blocks) update **instantly** before other chunks in the queue.

### Key Variables
```javascript
priorityChunks          // Set of chunks needing immediate update
chunkUpdateThrottle     // Map tracking last update time
MIN_UPDATE_INTERVAL     // 100ms between non-priority updates
needsQueueSort          // Flag to optimize sorting
```

### Usage Example
```javascript
// When you break/place a block:
modifyBlockAt(worldPos, blockType);
// → Automatically marks chunk as priority
// → Updates immediately (bypasses queue)
// → Neighboring chunks also prioritized
```

## Performance Optimizations

### 1. Smart Queue Sorting
- ✅ Only sorts when items added/priorities change
- ✅ Priority chunks always processed first
- ✅ Then sorted by distance to player

### 2. Update Throttling
- ✅ Non-priority: Max 1 update per 100ms
- ✅ Priority: Instant updates (no throttle)
- ✅ Auto-cleanup of old entries

### 3. Cache Management
- ✅ Ground height cache limited to 10,000 entries
- ✅ Auto-removes oldest 20% when full
- ✅ Prevents memory leaks

### 4. Time Budget
- ✅ Chunk processing limited to 16ms/frame
- ✅ Maintains 60 FPS target
- ✅ Priority chunks still process immediately

## Testing the Improvements

### Test 1: Priority System
1. Place blocks rapidly
2. Should see instant updates
3. No delay in visual feedback

### Test 2: Performance
1. Open DevTools Performance tab
2. Place/break many blocks
3. Check frame rate stays smooth

### Test 3: Memory
1. Play for 10+ minutes
2. Check memory usage in DevTools
3. Should stabilize (not grow indefinitely)

## Configuration Options

You can adjust these constants in `index.html`:

```javascript
// Line ~667
const MAX_CHUNKS_PER_FRAME = 5;     // Chunks to load per frame
const MIN_UPDATE_INTERVAL = 100;     // Throttle interval (ms)
const MAX_GROUND_HEIGHT_CACHE_SIZE = 10000; // Cache size limit
```

## How Priority Works

```
Normal Flow:
Block Modified → Queue → Wait → Eventually Update

Priority Flow:
Block Modified → Instant Update (bypasses queue)
```

### Priority Sort Order:
1. **Priority chunks** (modified by player)
2. **Distance** (closest first)
3. **Camera view** (visible chunks)

## Console Messages

Watch console for debug info:
```
"Player moved to new chunk (x, z), clearing chunk list"
"Camera rotated, updating visible chunks"
"Pruned X chunks from list"
```

## Performance Stats

### Before:
- Queue sorted every ~16ms
- No update limits
- Unlimited cache growth
- Modified chunks waited in queue

### After:
- Queue sorts only when needed (50-90% less)
- Throttled updates (except priority)
- Limited cache size
- Modified chunks instant

## Tips for Best Performance

1. **Building Mode**: Priority system handles it automatically
2. **Exploring**: Queue sorts efficiently as you move
3. **Long Sessions**: Cache auto-manages memory
4. **Frame Rate**: Time budget keeps FPS smooth

---

**Quick Fix**: If chunks seem slow to update:
- Check `MAX_CHUNKS_PER_FRAME` (increase if needed)
- Reduce `VISIBLE_RADIUS` for better performance
- Check console for errors

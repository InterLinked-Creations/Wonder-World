### 🧠 GitHub Copilot Prompt: Voxel Engine with Dual Contouring & Chunk Generation

**Project Context:**
This JavaScript project is a voxel-based engine with a file structure designed for modular **GamePacks**, which act as both Behavior Packs and Data Packs.

* The **default GamePack** is named `*:DEFAULT:*` and is stored in `/data/`.
* All **custom GamePacks** are stored in `/lib/gamePacks/[NameOfGamePack]/`.
* Each GamePack contains configuration for biomes, noise functions, and block/voxel data types.

✅ Completed

---

**Engine Overview:**
The world is divided into **chunks**, each responsible for storing and generating voxel data.
Each chunk:

* Stores voxel information in raw data format.
* Uses **Dual Contouring** to convert voxel density fields into **low-polygon terrain meshes** for rendering efficiency.
* Can store voxels of different data types:

  * `"mesh"` — affects terrain mesh generation.
  * `"structure"` — appears as solid, cubic blocks in the world.

Voxel data should be generated in several **Web Workers** to avoid main thread blocking.
The main thread will handle rendering, input, and UI.

✅ Completed

---

### 🌍 Chunk Generation System

Describe and implement a **Minecraft-like procedural generation pipeline** with strong attention to performance and modularity:

#### 1. Seed Initialization

* Use a deterministic PRNG seeded from a string (e.g. `"WonderWorldSeed"`).
* Ensure the same seed produces the same world layout.

#### 2. Procedural Noise & Terrain Generation

* Implement **multi-octave Perlin/Simplex noise** to determine terrain heightmaps.
* Blend multiple noise layers for realistic variation:

* **Base terrain noise**
* **Mountain noise**
* **Cave/carver noise**
* **Surface variation**
* Optimize for performance: precompute noise tables, cache noise per chunk.

#### 3. Biome Assignment (Skip this @Copilot)

* Assign biomes based on temperature, humidity, and elevation noise maps.
* Each biome (defined in GamePacks) provides:

* Terrain blocks (e.g. grass, sand, stone)
* Vegetation & decoration features
* Surface rules (top layer, filler layer, etc.)

#### 4. Feature Placement (Skip this @Copilot)

* Use biome rules to place structures like trees, rocks, and water bodies.
* Features should use `"structure"` voxels.
* Keep feature placement lightweight — only generate features after chunk terrain data exists.

#### 5. Chunk Data Building

* Each chunk builds only **voxel data**, not polygon meshes.
* Dual Contouring runs afterward using the voxel density field.
* Include chunk coordinate mapping `(x, y, z)` for world offsets.
* Handle seamless transitions between neighboring chunks.

#### 6. Chunk Loading / Unloading

* Generate chunks asynchronously using Web Workers.
* Maintain an in-memory cache for loaded chunks around the player.
* Unload distant chunks to free memory.
* Use an efficient system for voxel memory management and chunk reuse.

#### 7. Meshing and Blocks (added note)

* If a block has the type of `"mesh"`, then this block should have an effect on neighboring mesh blocks' shape.
* If a block has a type of `"structure"`, then this block should have the regular blocky-ness with the same culling rules.
* Meshing blocks should be shaped by using polygons (which has no limit to how many points it's built on).
* Structure blocks have minimal effect on terrain mesh. If a block is occupying where a mesh block wants to slope, then it'll adapt and change how it's shaped.
* Blocks are culled the same way they are currently.

🤖 Copilot's next task!
---

### 🎮 Player Controls

Implement first-person movement and camera control:

* **W, A, S, D** → Move
* **Space** → Jump
* **Shift** → Sneak
* **Mouse movement** → Look around
* When the mouse is **not locked**, the game pauses and shows the pause menu.

✅ Complete

---

### ⏸️ Pause Menu

When paused:

* Show a centered pause menu overlay with:

  * **Resume** button (resumes game and re-locks mouse)
  * **Settings** button (opens placeholder settings screen)
  * **Save and Quit** button (currently placeholder, no functionality yet)
* Menu should use HTML/CSS or in-engine GUI elements.

🔄️ In Progress
---

### 🌅 Day/Night Cycle

Add a smooth day/night cycle:

* Cycle time: ~10 minutes for full day.
* Sun and moon are round, moving across the sky in a simple arc.
* Adjust ambient lighting and sky color over time.

❎ Not Implemented
---

### 🧩 Summary

> Generate a **voxel-based chunk generation system** for a JavaScript engine using **Dual Contouring** to convert voxel density data into polygon meshes.
>
> The system must:
>
> * Generate chunks using **procedural noise and biomes**.
> * Run generation in a **Web Worker** for performance.
> * Separate voxel data (raw) from the mesh.
> * Support `"mesh"` and `"structure"` voxel types.
> * Handle player controls, pause menu, and day/night cycle.
> * Follow Minecraft-style world generation logic (seed, noise, biomes, features, chunk loading).

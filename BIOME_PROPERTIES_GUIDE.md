# Biome Property Effects Guide

This guide explains what each biome property in `biomes.json` does to the terrain generation.

## Basic Properties

### Already Used (Before Update)
- **baseHeight**: The base elevation of the biome (e.g., 65 for plains, 120 for mountains)
- **heightVariation**: How much the height can vary from the base (adds randomness)
- **defaultLayer**: The default block type below the surface layers (usually "stone")
- **layers**: Surface block layers (e.g., grass, dirt, sand)
- **structures**: What structures spawn in this biome (trees, houses, etc.)

## NEW Properties Being Used (After Update)

### Terrain Shape Modifiers
- **heightAmplitude** (0.0-2.0): Multiplies the height variation
  - 1.0 = normal, 1.5 = 50% taller, 0.5 = flatter
  - Example: Desert = 1.2 (slightly taller dunes), Plains = 1.0 (normal)

- **terrainRoughness** (0.0-1.0): Controls how rough/smooth the terrain is
  - 0.0 = very smooth, 1.0 = very rough and jagged
  - Example: Desert = 0.6 (rough dunes), Tundra = 0.4 (moderate)

- **slopeIntensity** (0.0-1.0): Controls how steep slopes can be
  - 0.0 = gentle slopes, 1.0 = very steep slopes
  - Example: Mountain = 0.8 (steep), Plains = 0.4 (gentle)

### Geological Formations

- **plateauChance** (0.0-1.0): Probability of flat plateau areas forming
  - Higher = more flat-topped formations
  - Example: Desert = 0.25 (mesas), Forest = 0.05 (rare)

- **valleyDepth** (0-20): How deep valleys can be
  - Higher = deeper valleys
  - Example: Desert = 8 (deep canyons), Plains = 2 (shallow)

- **ridgeHeight** (0-30): How tall ridges/hills can be
  - Higher = taller ridges
  - Example: Desert = 12 (tall ridges), Plains = 4 (low hills)

- **erosionFactor** (0.0-1.0): How much erosion affects the terrain
  - Higher = more eroded/carved terrain
  - Example: Desert = 0.8 (heavily eroded), Forest = 0.15 (protected by vegetation)

- **sedimentationRate** (0.0-1.0): Material accumulation in low areas
  - Higher = more filled-in valleys
  - Example: Desert = 0.7 (sand fills valleys), Plains = 0.3 (moderate)

- **weatheringRate** (0.0-1.0): Rate of terrain smoothing over time
  - Higher = smoother, more weathered terrain
  - Example: Desert = 0.9 (heavily weathered), Tundra = 0.05 (minimal)

- **upliftForce** (0.0-1.0): Tectonic uplift influence on base elevation
  - Higher = more elevated terrain overall
  - Example: Forest = 0.15 (elevated), Desert = 0.05 (low-lying)

### Noise Generation (Controls Detail Level)

- **primaryNoiseScale** (0.001-0.1): Scale of main terrain features
  - Lower = larger features, Higher = smaller features
  - Example: Desert = 0.015 (large dunes), Plains = 0.02 (medium)

- **secondaryNoiseScale** (0.01-0.5): Scale of medium-sized details
  - Controls mid-range terrain variation
  - Example: Desert = 0.06, Plains = 0.08

- **detailNoiseScale** (0.1-1.0): Scale of fine details
  - Controls small bumps and texture
  - Example: Plains = 0.2, Forest = 0.3

- **noiseOctaves** (1-8): Number of noise layers to combine
  - More octaves = more complex, detailed terrain (but slower)
  - Example: Desert = 6 (very detailed), Tundra = 3 (simpler)

- **persistance** (0.0-1.0): How quickly amplitude decreases per octave
  - 0.5 = each octave is half as strong
  - Example: Desert = 0.6 (maintains detail), Tundra = 0.4 (less detail)

- **lacunarity** (1.0-3.0): How quickly frequency increases per octave
  - 2.0 = each octave is twice the frequency
  - Example: Desert = 2.2 (more variation), Plains = 2.0 (normal)

- **domainWarpStrength** (0.0-1.0): Strength of warping effect
  - Higher = more organic, flowing shapes
  - Example: Desert = 0.8 (flowing dunes), Plains = 0.3 (subtle)

### Terrain Features

- **hillDensity** (0.0-1.0): How many hills appear
  - Example: Forest = 0.5 (many hills), Plains = 0.3 (few hills)

- **craterChance** (0.0-0.1): Probability of crater-like depressions
  - Example: Desert = 0.08 (some craters), Plains = 0.02 (rare)

- **mesaFormations** (true/false): Enable mesa/plateau formations
  - Example: Desert = true, Plains = false

- **canyonCarving** (true/false): Enable canyon carving
  - Example: Desert = true (canyons), Forest = false

- **riverCarving** (0.0-0.5): Strength of river carving
  - Higher = deeper, more pronounced rivers
  - Example: Plains = 0.1, Forest = 0.2

- **lakeGeneration** (0.0-0.3): Probability of lakes forming
  - Example: Tundra = 0.15 (many lakes), Desert = 0.01 (rare)

### Special Geological Features

- **rockOutcrops** (0.0-0.5): Probability of exposed rock formations
  - Example: Desert = 0.3 (common), Plains = 0.1 (rare)

- **boulderFields** (0.0-0.5): Probability of boulder clusters
  - Example: Tundra = 0.3 (common), Plains = 0.05 (rare)

- **terraceFormation** (true/false): Enable terraced formations
  - Example: Desert = true (step-like mesas), Plains = false

- **screeSlopes** (0.0-0.5): Probability of loose rock slopes
  - Example: Desert = 0.25 (common), Plains = 0.05 (rare)

- **naturalArches** (0.0-0.1): Probability of natural arch formations
  - Example: Desert = 0.08 (iconic desert arches), Plains = 0.01 (very rare)

### Environmental Effects

- **frostHeave** (0.0-1.0): Frost action in cold biomes (adds roughness)
  - Example: Tundra = 0.8 (strong effect), Plains = 0.0 (none)

- **thermalExpansion** (0.0-1.0): Thermal effects (micro-variations)
  - Example: Desert = 0.6 (strong), Tundra = 0.02 (minimal)

- **windErosion** (0.0-1.0): Wind erosion effect (smooths/carves)
  - Example: Desert = 0.8 (heavy wind), Forest = 0.15 (sheltered)

- **rainErosion** (0.0-1.0): Rain erosion effect (smooths terrain)
  - Example: Plains = 0.2, Tundra = 0.1

- **snowLoad** (0.0-1.0): Snow compression effect (slight depression)
  - Example: Tundra = 0.6 (heavy snow), Plains = 0.0 (none)

### Advanced Noise Effects

- **fractalDimension** (1.0-3.0): Overall terrain complexity
  - Higher = more fractal-like complexity
  - Example: Desert = 2.1 (complex), Tundra = 1.6 (simpler)

- **harmonicDistortion** (0.0-1.0): Sine wave distortion (creates waves)
  - Example: Desert = 0.4 (rippled dunes), Plains = 0.1 (subtle)

- **voronoiInfluence** (0.0-0.5): Cell-based patterns
  - Creates cell-like structures
  - Example: Desert = 0.3 (cellular patterns), Plains = 0.05 (subtle)

- **perlinWarp** (0.0-1.0): Perlin-based warping
  - Example: Desert = 0.5, Plains = 0.2

- **simplexBlend** (0.0-1.0): Adds organic variation
  - Example: Forest = 0.4 (organic), Tundra = 0.4

## How to Customize Your Biomes

### To make a biome flatter:
- Decrease `heightVariation`
- Decrease `heightAmplitude`
- Decrease `terrainRoughness`
- Decrease `slopeIntensity`

### To make a biome more mountainous:
- Increase `baseHeight`
- Increase `heightVariation`
- Increase `heightAmplitude`
- Increase `slopeIntensity`
- Increase `hillDensity`
- Increase `ridgeHeight`

### To make a biome more desert-like:
- Enable `mesaFormations`
- Enable `canyonCarving`
- Enable `terraceFormation`
- Increase `windErosion`
- Increase `domainWarpStrength`
- Increase `rockOutcrops`
- Increase `screeSlopes`

### To make a biome more forest-like:
- Increase `heightVariation`
- Increase `hillDensity`
- Increase `riverCarving`
- Increase `lakeGeneration`
- Decrease `erosionFactor`
- Decrease `windErosion`

### To make a cold biome (tundra/ice):
- Increase `frostHeave`
- Increase `snowLoad`
- Increase `boulderFields`
- Decrease `thermalExpansion`
- Decrease `rainErosion`

## Example Biome Configurations

### Extreme Desert
```json
{
    "baseHeight": 62,
    "heightVariation": 25,
    "heightAmplitude": 1.5,
    "terrainRoughness": 0.8,
    "mesaFormations": true,
    "canyonCarving": true,
    "terraceFormation": true,
    "windErosion": 0.9,
    "erosionFactor": 0.9,
    "domainWarpStrength": 0.9,
    "rockOutcrops": 0.4,
    "naturalArches": 0.15
}
```

### Gentle Plains
```json
{
    "baseHeight": 65,
    "heightVariation": 5,
    "heightAmplitude": 0.8,
    "terrainRoughness": 0.2,
    "slopeIntensity": 0.3,
    "weatheringRate": 0.4,
    "hillDensity": 0.2
}
```

### Rugged Mountains
```json
{
    "baseHeight": 120,
    "heightVariation": 40,
    "heightAmplitude": 2.0,
    "terrainRoughness": 0.9,
    "slopeIntensity": 0.9,
    "hillDensity": 0.7,
    "ridgeHeight": 25,
    "rockOutcrops": 0.5,
    "boulderFields": 0.3,
    "screeSlopes": 0.4
}
```

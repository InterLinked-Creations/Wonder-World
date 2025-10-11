# Biome Data Integration Update

## Overview
Updated the World Generator in `chunkWorker.js` to use **ALL** biome properties from `biomes.json` for terrain generation, with proper default values for backward compatibility.

## What Was Changed

### Modified Function: `calculateSophisticatedHeight()`
This function now reads and applies all terrain generation properties from each biome's configuration.

### New Properties Being Used

#### 1. **Basic Terrain Properties**
- `heightAmplitude` - Multiplier for overall height variation (default: 1.0)
- `terrainRoughness` - Controls terrain roughness/smoothness (default: 0.5)
- `slopeIntensity` - Controls slope steepness (default: 0.5)

#### 2. **Geological Formation Properties**
- `plateauChance` - Probability of plateau formation (default: 0.1)
- `valleyDepth` - Depth of valleys (default: 5)
- `ridgeHeight` - Height of ridges (default: 8)
- `erosionFactor` - How much erosion affects terrain (default: 0.3)
- `sedimentationRate` - How much material accumulates in low areas (default: 0.3)
- `weatheringRate` - Rate of terrain smoothing (default: 0.3)
- `upliftForce` - Tectonic uplift influence (default: 0.1)

#### 3. **Noise Generation Properties**
- `primaryNoiseScale` - Scale of primary terrain noise (default: 0.02)
- `secondaryNoiseScale` - Scale of secondary terrain noise (default: 0.08)
- `detailNoiseScale` - Scale of detail terrain noise (default: 0.2)
- `noiseOctaves` - Number of noise layers (default: 4)
- `persistance` - How quickly amplitude decreases per octave (default: 0.5)
- `lacunarity` - How quickly frequency increases per octave (default: 2.0)
- `domainWarpStrength` - Strength of domain warping effect (default: 0.3)

#### 4. **Terrain Feature Properties**
- `hillDensity` - Density of hills in terrain (default: 0.3)
- `craterChance` - Probability of crater formation (default: 0.0)
- `mesaFormations` - Enable mesa/plateau formations (default: false)
- `canyonCarving` - Enable canyon carving (default: false)
- `riverCarving` - Strength of river carving (default: 0.1)
- `lakeGeneration` - Lake generation probability (default: 0.05)

#### 5. **Geological Features**
- `rockOutcrops` - Probability of rock outcrops (default: 0.1)
- `boulderFields` - Probability of boulder fields (default: 0.05)
- `terraceFormation` - Enable terrace formations (default: false)
- `screeSlopes` - Probability of scree slopes (default: 0.05)
- `naturalArches` - Probability of natural arches (default: 0.01)

#### 6. **Environmental Effects**
- `frostHeave` - Frost heave effect in cold biomes (default: 0.0)
- `thermalExpansion` - Thermal expansion micro-variations (default: 0.1)
- `windErosion` - Wind erosion effect (default: 0.2)
- `rainErosion` - Rain erosion smoothing (default: 0.2)
- `snowLoad` - Snow compression effect (default: 0.0)

#### 7. **Advanced Noise Properties**
- `fractalDimension` - Fractal complexity of terrain (default: 1.8)
- `harmonicDistortion` - Harmonic distortion amount (default: 0.1)
- `voronoiInfluence` - Voronoi cell-based influence (default: 0.05)
- `perlinWarp` - Perlin noise warping (default: 0.2)
- `simplexBlend` - Simplex noise blending (default: 0.3)

### New Helper Function
Added `multiOctaveNoiseCustom()` function that supports custom `persistance` and `lacunarity` values for more precise noise generation control.

## How It Works

1. **Property Extraction**: The function extracts all properties from the biome object with fallback to sensible defaults if not specified
2. **Custom Noise Generation**: Uses biome-specific noise scales and parameters for primary, secondary, and detail noise layers
3. **Domain Warping**: Applies domain warping based on biome's `domainWarpStrength`
4. **Terrain Modifications**: Applies all geological and environmental effects based on biome properties
5. **Special Features**: Adds craters, rock outcrops, boulders, arches, etc. based on biome settings
6. **Advanced Noise Blending**: Applies Voronoi, harmonic distortion, and simplex blending
7. **Fractal Scaling**: Adjusts overall terrain complexity based on `fractalDimension`

## Benefits

1. **Full Biome Customization**: Every biome can now have completely unique terrain characteristics
2. **Backward Compatibility**: Old biomes without these properties still work with sensible defaults
3. **Rich Terrain Variety**: Supports complex geological features like mesas, canyons, terraces, etc.
4. **Environmental Effects**: Realistic weathering, erosion, frost effects, etc.
5. **Advanced Noise Control**: Fine-grained control over terrain generation at multiple scales

## Example Biome Usage

```json
{
    "desert": {
        "baseHeight": 62,
        "heightVariation": 18,
        "heightAmplitude": 1.2,
        "terrainRoughness": 0.6,
        "primaryNoiseScale": 0.015,
        "noiseOctaves": 6,
        "mesaFormations": true,
        "canyonCarving": true,
        "windErosion": 0.8,
        "domainWarpStrength": 0.8
    }
}
```

This desert biome will now have:
- Taller, more varied terrain (heightAmplitude: 1.2)
- Rougher surfaces (terrainRoughness: 0.6)
- Mesa plateaus and canyon features
- Strong wind erosion effects
- Strong domain warping for organic dune shapes

## Testing

To test the changes:
1. Start the server: `node server.js`
2. Open the game in browser
3. Explore different biomes to see the new terrain features
4. Each biome should now show unique terrain characteristics based on its properties

## Notes

- All properties have sensible defaults, so existing biomes continue to work
- Performance impact is minimal due to caching
- The system gracefully handles missing properties

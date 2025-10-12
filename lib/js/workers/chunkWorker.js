// Chunk Worker
// Note: We'll receive needed variables and constants from the main thread

let CHUNK_SIZE, WORLD_HEIGHT, BLOCK_TYPES, BIOMES, worldSeed, StructureGenerators;
let blockColors; // Will be populated from main thread
let biomeScale; // Will be populated from main thread

// Advanced terrain system constants (mirrored from main thread)
let BIOME_ADJACENCY, GEOLOGICAL_FORMATIONS, TERRAIN_BOUNDS, NOISE_CONFIG;
let AdvancedNoiseGenerator;

// Add chunk storage
const chunkStorage = new Map();
const neighborChunks = new Map(); // Store neighboring chunks for proper culling
const biomeStorage = new Map(); // Store computed biomes for adjacency checking

// Performance optimization: Cache noise calculations
const noiseCache = new Map();
const NOISE_CACHE_SIZE = 10000; // Limit cache size to prevent memory issues
let noiseCacheHits = 0;
let noiseCacheMisses = 0;

// Advanced terrain generation helper functions (worker versions)
function areBiomesCompatible(biome1, biome2) {
    if (!BIOME_ADJACENCY || !BIOME_ADJACENCY[biome1] || !BIOME_ADJACENCY[biome2]) return false;
    
    const biome1Compat = BIOME_ADJACENCY[biome1];
    return biome1Compat.compatible.includes(biome2) || 
           biome1Compat.transitional.includes(biome2);
}

function getBiomeTransitionType(biome1, biome2) {
    if (!BIOME_ADJACENCY || !BIOME_ADJACENCY[biome1]) return 'incompatible';
    
    const compat = BIOME_ADJACENCY[biome1];
    if (compat.compatible.includes(biome2)) return 'direct';
    if (compat.transitional.includes(biome2)) return 'buffered';
    return 'incompatible';
}

function calculateSophisticatedHeight(x, z, biomeName, noiseGen, neighborBiomes) {
    if (!BIOMES || !BIOMES[biomeName] || !NOISE_CONFIG || !TERRAIN_BOUNDS) {
        // Fallback to simple height calculation
        const n = noiseGen.noise(x * 0.01, 0, z * 0.01);
        return Math.floor(65 + n * 15);
    }
    
    const biome = BIOMES[biomeName];
    
    // Extract biome properties with defaults
    const heightAmplitude = biome.heightAmplitude !== undefined ? biome.heightAmplitude : 1.0;
    const terrainRoughness = biome.terrainRoughness !== undefined ? biome.terrainRoughness : 0.5;
    const slopeIntensity = biome.slopeIntensity !== undefined ? biome.slopeIntensity : 0.5;
    
    const plateauChance = biome.plateauChance !== undefined ? biome.plateauChance : 0.1;
    const valleyDepth = biome.valleyDepth !== undefined ? biome.valleyDepth : 5;
    const ridgeHeight = biome.ridgeHeight !== undefined ? biome.ridgeHeight : 8;
    const erosionFactor = biome.erosionFactor !== undefined ? biome.erosionFactor : 0.3;
    const sedimentationRate = biome.sedimentationRate !== undefined ? biome.sedimentationRate : 0.3;
    const weatheringRate = biome.weatheringRate !== undefined ? biome.weatheringRate : 0.3;
    const upliftForce = biome.upliftForce !== undefined ? biome.upliftForce : 0.1;
    
    const primaryNoiseScale = biome.primaryNoiseScale !== undefined ? biome.primaryNoiseScale : 0.02;
    const secondaryNoiseScale = biome.secondaryNoiseScale !== undefined ? biome.secondaryNoiseScale : 0.08;
    const detailNoiseScale = biome.detailNoiseScale !== undefined ? biome.detailNoiseScale : 0.2;
    const noiseOctaves = biome.noiseOctaves !== undefined ? biome.noiseOctaves : 4;
    const persistance = biome.persistance !== undefined ? biome.persistance : 0.5;
    const lacunarity = biome.lacunarity !== undefined ? biome.lacunarity : 2.0;
    const domainWarpStrength = biome.domainWarpStrength !== undefined ? biome.domainWarpStrength : 0.3;
    
    const hillDensity = biome.hillDensity !== undefined ? biome.hillDensity : 0.3;
    const craterChance = biome.craterChance !== undefined ? biome.craterChance : 0.0;
    const mesaFormations = biome.mesaFormations !== undefined ? biome.mesaFormations : false;
    const canyonCarving = biome.canyonCarving !== undefined ? biome.canyonCarving : false;
    const riverCarving = biome.riverCarving !== undefined ? biome.riverCarving : 0.1;
    const lakeGeneration = biome.lakeGeneration !== undefined ? biome.lakeGeneration : 0.05;
    
    const rockOutcrops = biome.rockOutcrops !== undefined ? biome.rockOutcrops : 0.1;
    const boulderFields = biome.boulderFields !== undefined ? biome.boulderFields : 0.05;
    const terraceFormation = biome.terraceFormation !== undefined ? biome.terraceFormation : false;
    const screeSlopes = biome.screeSlopes !== undefined ? biome.screeSlopes : 0.05;
    const naturalArches = biome.naturalArches !== undefined ? biome.naturalArches : 0.01;
    
    const frostHeave = biome.frostHeave !== undefined ? biome.frostHeave : 0.0;
    const thermalExpansion = biome.thermalExpansion !== undefined ? biome.thermalExpansion : 0.1;
    const windErosion = biome.windErosion !== undefined ? biome.windErosion : 0.2;
    const rainErosion = biome.rainErosion !== undefined ? biome.rainErosion : 0.2;
    const snowLoad = biome.snowLoad !== undefined ? biome.snowLoad : 0.0;
    
    const fractalDimension = biome.fractalDimension !== undefined ? biome.fractalDimension : 1.8;
    const harmonicDistortion = biome.harmonicDistortion !== undefined ? biome.harmonicDistortion : 0.1;
    const voronoiInfluence = biome.voronoiInfluence !== undefined ? biome.voronoiInfluence : 0.05;
    const perlinWarp = biome.perlinWarp !== undefined ? biome.perlinWarp : 0.2;
    const simplexBlend = biome.simplexBlend !== undefined ? biome.simplexBlend : 0.3;
    
    // Base continental elevation
    const continentalNoise = multiOctaveNoise(noiseGen, x, z, NOISE_CONFIG.continental);
    const regionalNoise = multiOctaveNoise(noiseGen, x, z, NOISE_CONFIG.regional);
    const continentalShape = continentalNoise * 0.7 + regionalNoise * 0.3;
    let elevation = TERRAIN_BOUNDS.sea_level + continentalShape * upliftForce * 100;
    elevation = Math.max(TERRAIN_BOUNDS.min_elevation, elevation);
    
    // Apply geological formations using biome-specific settings
    if (biome.transition !== "None") {
        const formationNoise = multiOctaveNoise(noiseGen, x, z, NOISE_CONFIG.formation || { frequency: primaryNoiseScale * 0.25, amplitude: 20, octaves: noiseOctaves });
        const formationStrength = Math.abs(formationNoise);
        
        // Mesa/Plateau formations
        if (mesaFormations || (GEOLOGICAL_FORMATIONS && GEOLOGICAL_FORMATIONS.MESA && formationStrength > 0.7)) {
            const plateauNoise = ridgedNoise(noiseGen, x, z, { frequency: primaryNoiseScale * 0.4, amplitude: ridgeHeight * 2, octaves: Math.max(2, noiseOctaves - 2) });
            const plateauTest = noiseGen.noise(x * primaryNoiseScale * 0.3, 1000, z * primaryNoiseScale * 0.3);
            if (Math.abs(plateauTest) < plateauChance) {
                elevation += plateauNoise * heightAmplitude * (terraceFormation ? 1.5 : 1.0);
            }
        }
        
        // Ridge formations
        if (formationStrength > 0.4 || hillDensity > 0.4) {
            const ridgeNoise = ridgedNoise(noiseGen, x, z, { frequency: primaryNoiseScale * 0.75, amplitude: ridgeHeight, octaves: noiseOctaves });
            elevation += ridgeNoise * heightAmplitude * hillDensity;
        }
        
        // Valley/Canyon carving
        if (canyonCarving || formationNoise < -0.4) {
            const valleyNoise = Math.abs(formationNoise + 0.4) * valleyDepth * 6;
            elevation -= valleyNoise * erosionFactor;
        }
        
        // River carving
        if (riverCarving > 0) {
            const riverNoise = Math.abs(noiseGen.noise(x * primaryNoiseScale * 0.15, 2000, z * primaryNoiseScale * 0.15));
            if (riverNoise < riverCarving * 0.5) {
                const riverDepth = (riverCarving * 0.5 - riverNoise) * 40;
                elevation -= riverDepth * erosionFactor;
            }
        }
    }
    
    // Local biome-specific terrain with custom noise scales
    const primaryNoise = multiOctaveNoiseCustom(noiseGen, x, z, {
        frequency: primaryNoiseScale,
        amplitude: biome.heightVariation * heightAmplitude,
        octaves: noiseOctaves,
        persistance: persistance,
        lacunarity: lacunarity
    });
    
    const secondaryNoise = multiOctaveNoiseCustom(noiseGen, x, z, {
        frequency: secondaryNoiseScale,
        amplitude: biome.heightVariation * heightAmplitude * 0.5,
        octaves: Math.max(2, noiseOctaves - 1),
        persistance: persistance,
        lacunarity: lacunarity
    });
    
    const detailNoise = multiOctaveNoiseCustom(noiseGen, x, z, {
        frequency: detailNoiseScale,
        amplitude: biome.heightVariation * heightAmplitude * 0.25,
        octaves: Math.max(1, noiseOctaves - 2),
        persistance: persistance,
        lacunarity: lacunarity
    });
    
    // Apply domain warping
    let warpedX = x;
    let warpedZ = z;
    if (domainWarpStrength > 0) {
        const warpOffsetX = noiseGen.noise(x * primaryNoiseScale * 0.5, 5000, z * primaryNoiseScale * 0.5) * domainWarpStrength * 50;
        const warpOffsetZ = noiseGen.noise(x * primaryNoiseScale * 0.5, 6000, z * primaryNoiseScale * 0.5) * domainWarpStrength * 50;
        warpedX += warpOffsetX;
        warpedZ += warpOffsetZ;
    }
    
    // Combine terrain features with terrain roughness
    let biomeModification = primaryNoise * (0.6 + terrainRoughness * 0.4);
    biomeModification += secondaryNoise * (0.3 + terrainRoughness * 0.2);
    biomeModification += detailNoise * (0.1 + terrainRoughness * 0.1);
    
    // Apply slope intensity
    const slopeNoise = noiseGen.noise(warpedX * detailNoiseScale * 1.5, 3000, warpedZ * detailNoiseScale * 1.5);
    biomeModification *= (1.0 + slopeNoise * slopeIntensity * 0.5);
    
    // Apply environmental effects
    // Weathering smooths terrain
    biomeModification *= (1.0 - weatheringRate * 0.3);
    
    // Wind erosion (directional)
    if (windErosion > 0) {
        const windDirection = noiseGen.noise(x * primaryNoiseScale * 0.1, 7000, z * primaryNoiseScale * 0.1);
        biomeModification -= windDirection * windErosion * 2;
    }
    
    // Rain erosion (general smoothing)
    if (rainErosion > 0) {
        biomeModification *= (1.0 - rainErosion * 0.2);
    }
    
    // Frost heave (increases roughness in cold biomes)
    if (frostHeave > 0) {
        const frostNoise = noiseGen.noise(x * detailNoiseScale * 2, 8000, z * detailNoiseScale * 2);
        biomeModification += frostNoise * frostHeave * 3;
    }
    
    // Snow load (compresses terrain slightly)
    if (snowLoad > 0) {
        biomeModification -= snowLoad * 2;
    }
    
    // Thermal expansion (adds micro-variations)
    if (thermalExpansion > 0) {
        const thermalNoise = noiseGen.noise(x * detailNoiseScale * 3, 9000, z * detailNoiseScale * 3);
        biomeModification += thermalNoise * thermalExpansion * 1.5;
    }
    
    // Special geological features
    // Craters
    if (craterChance > 0) {
        const craterTest = noiseGen.noise(x * primaryNoiseScale * 0.2, 10000, z * primaryNoiseScale * 0.2);
        if (Math.abs(craterTest) < craterChance * 0.1) {
            const craterDepth = (craterChance * 0.1 - Math.abs(craterTest)) * 200;
            biomeModification -= craterDepth;
        }
    }
    
    // Rock outcrops
    if (rockOutcrops > 0) {
        const outcropNoise = noiseGen.noise(x * secondaryNoiseScale * 1.5, 11000, z * secondaryNoiseScale * 1.5);
        if (outcropNoise > (1.0 - rockOutcrops)) {
            biomeModification += (outcropNoise - (1.0 - rockOutcrops)) * 15;
        }
    }
    
    // Boulder fields
    if (boulderFields > 0) {
        const boulderNoise = noiseGen.noise(x * detailNoiseScale * 2.5, 12000, z * detailNoiseScale * 2.5);
        if (boulderNoise > (1.0 - boulderFields)) {
            biomeModification += (boulderNoise - (1.0 - boulderFields)) * 8;
        }
    }
    
    // Scree slopes (angular debris)
    if (screeSlopes > 0) {
        const screeNoise = Math.abs(noiseGen.noise(x * secondaryNoiseScale, 13000, z * secondaryNoiseScale));
        if (screeNoise > (1.0 - screeSlopes)) {
            biomeModification -= (screeNoise - (1.0 - screeSlopes)) * 10;
        }
    }
    
    // Natural arches (rare formations)
    if (naturalArches > 0) {
        const archNoise = noiseGen.noise(x * primaryNoiseScale * 0.15, 14000, z * primaryNoiseScale * 0.15);
        if (Math.abs(archNoise) < naturalArches * 0.05) {
            const archHeight = (naturalArches * 0.05 - Math.abs(archNoise)) * 100;
            biomeModification += archHeight;
        }
    }
    
    // Apply advanced noise blending
    if (voronoiInfluence > 0 || harmonicDistortion > 0 || simplexBlend > 0) {
        const advancedNoise1 = noiseGen.noise(x * primaryNoiseScale * 1.5, 15000, z * primaryNoiseScale * 1.5);
        const advancedNoise2 = noiseGen.noise(x * secondaryNoiseScale * 0.75, 16000, z * secondaryNoiseScale * 0.75);
        
        // Voronoi-like influence (cell-based)
        if (voronoiInfluence > 0) {
            const cellNoise = Math.abs(advancedNoise1);
            biomeModification += (cellNoise - 0.5) * voronoiInfluence * 10;
        }
        
        // Harmonic distortion
        if (harmonicDistortion > 0) {
            biomeModification *= (1.0 + Math.sin(advancedNoise2 * Math.PI * 2) * harmonicDistortion);
        }
        
        // Simplex blend (adds organic variation)
        if (simplexBlend > 0) {
            biomeModification += advancedNoise1 * advancedNoise2 * simplexBlend * 5;
        }
    }
    
    // Apply fractal dimension (affects overall terrain complexity)
    const fractalScale = Math.pow(fractalDimension / 2.0, 2);
    biomeModification *= fractalScale;
    
    // Sedimentation adds material to low areas
    if (sedimentationRate > 0 && biomeModification < 0) {
        biomeModification *= (1.0 - sedimentationRate * 0.3);
    }
    
    // Apply biome-specific terrain characteristics for named biome types
    if (biome.transition !== "None") {
        if (biomeName.includes('mountain') || biomeName.includes('peaks')) {
            const ridgedTerrain = ridgedNoise(noiseGen, x, z, { frequency: secondaryNoiseScale, amplitude: 30, octaves: noiseOctaves });
            biomeModification += ridgedTerrain * heightAmplitude;
        } else if (biomeName.includes('desert') || biomeName.includes('dunes')) {
            const duneNoise = domainWarpedNoise(noiseGen, x, z, { frequency: secondaryNoiseScale * 1.5, amplitude: 15, octaves: Math.max(3, noiseOctaves - 1) }, domainWarpStrength * 100);
            biomeModification += duneNoise * 0.8 * heightAmplitude;
        } else if (biomeName.includes('ocean') || biomeName.includes('lake')) {
            biomeModification *= 0.3;
        }
    } else {
        // For biomes with "None" transition, use smoother terrain
        if (biomeName.includes('ocean') || biomeName.includes('lake')) {
            biomeModification *= 0.3;
        } else {
            biomeModification *= 0.7;
        }
    }
    
    // Apply final biome modification
    elevation += biomeModification;
    
    // Apply height blending with nearby biomes to prevent ridgelines
    if (neighborBiomes && neighborBiomes.length > 0) {
        let blendSum = 0;
        let blendWeight = 0;
        
        for (const neighbor of neighborBiomes) {
            const distance = Math.sqrt(Math.pow(x - neighbor.x, 2) + Math.pow(z - neighbor.z, 2));
            if (distance < 150) {
                const weight = Math.max(0, 1 - distance / 150);
                const neighborBiome = BIOMES[neighbor.biome];
                if (neighborBiome) {
                    // Calculate base height for neighbor with some terrain variation
                    const neighborLocalNoise = multiOctaveNoise(noiseGen, neighbor.x, neighbor.z, NOISE_CONFIG.local);
                    const neighborHeight = neighborBiome.baseHeight + neighborLocalNoise * neighborBiome.heightVariation * 0.3;
                    blendSum += neighborHeight * weight;
                    blendWeight += weight;
                }
            }
        }
        
        if (blendWeight > 0) {
            const averageNeighborHeight = blendSum / blendWeight;
            const blendFactor = Math.min(0.5, blendWeight);
            elevation = elevation * (1 - blendFactor) + averageNeighborHeight * blendFactor;
        }
    }
    
    // Ensure within bounds
    elevation = Math.max(TERRAIN_BOUNDS.min_elevation, 
                       Math.min(TERRAIN_BOUNDS.max_elevation, elevation));
    
    return Math.floor(elevation);
}

// Helper noise functions for the worker with caching
function multiOctaveNoise(noiseGen, x, z, config) {
    // Create cache key with rounded coordinates for better cache hits
    const cacheKey = `${Math.floor(x * 100) / 100}:${Math.floor(z * 100) / 100}:${config.frequency}:${config.octaves}`;
    
    // Check cache first
    if (noiseCache.has(cacheKey)) {
        noiseCacheHits++;
        return noiseCache.get(cacheKey);
    }
    
    noiseCacheMisses++;
    let value = 0;
    let amplitude = config.amplitude;
    let frequency = config.frequency;
    let maxValue = 0;

    for (let i = 0; i < config.octaves; i++) {
        value += noiseGen.noise(x * frequency, 0, z * frequency) * amplitude;
        maxValue += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }

    const result = value / maxValue;
    
    // Store in cache if not full
    if (noiseCache.size < NOISE_CACHE_SIZE) {
        noiseCache.set(cacheKey, result);
    } else if (noiseCache.size === NOISE_CACHE_SIZE) {
        // Clear 20% of cache when full
        const keysToDelete = Array.from(noiseCache.keys()).slice(0, Math.floor(NOISE_CACHE_SIZE * 0.2));
        keysToDelete.forEach(k => noiseCache.delete(k));
        noiseCache.set(cacheKey, result);
    }
    
    return result;
}

// Custom multi-octave noise with configurable persistence and lacunarity
function multiOctaveNoiseCustom(noiseGen, x, z, config) {
    // Create cache key
    const cacheKey = `custom:${Math.floor(x * 100) / 100}:${Math.floor(z * 100) / 100}:${config.frequency}:${config.octaves}:${config.persistance}:${config.lacunarity}`;
    
    // Check cache first
    if (noiseCache.has(cacheKey)) {
        noiseCacheHits++;
        return noiseCache.get(cacheKey);
    }
    
    noiseCacheMisses++;
    let value = 0;
    let amplitude = config.amplitude;
    let frequency = config.frequency;
    let maxValue = 0;

    for (let i = 0; i < config.octaves; i++) {
        value += noiseGen.noise(x * frequency, i * 1000, z * frequency) * amplitude;
        maxValue += amplitude;
        amplitude *= config.persistance;  // Use custom persistence
        frequency *= config.lacunarity;   // Use custom lacunarity
    }

    const result = value / maxValue;
    
    // Store in cache if not full
    if (noiseCache.size < NOISE_CACHE_SIZE) {
        noiseCache.set(cacheKey, result);
    } else if (noiseCache.size === NOISE_CACHE_SIZE) {
        // Clear 20% of cache when full
        const keysToDelete = Array.from(noiseCache.keys()).slice(0, Math.floor(NOISE_CACHE_SIZE * 0.2));
        keysToDelete.forEach(k => noiseCache.delete(k));
        noiseCache.set(cacheKey, result);
    }
    
    return result;
}

function ridgedNoise(noiseGen, x, z, config) {
    // Cache ridged noise too
    const cacheKey = `ridged:${Math.floor(x * 100) / 100}:${Math.floor(z * 100) / 100}:${config.frequency}:${config.octaves}`;
    
    if (noiseCache.has(cacheKey)) {
        noiseCacheHits++;
        return noiseCache.get(cacheKey);
    }
    
    noiseCacheMisses++;
    let value = 0;
    let amplitude = config.amplitude;
    let frequency = config.frequency;

    for (let i = 0; i < config.octaves; i++) {
        let n = Math.abs(noiseGen.noise(x * frequency, 0, z * frequency));
        n = 1.0 - n;
        n = n * n;
        value += n * amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }

    if (noiseCache.size < NOISE_CACHE_SIZE) {
        noiseCache.set(cacheKey, value);
    }
    
    return value;
}

function domainWarpedNoise(noiseGen, x, z, config, warpStrength = 50) {
    const warpX = noiseGen.noise(x * 0.01, 0, z * 0.01) * warpStrength;
    const warpZ = noiseGen.noise(x * 0.01, 100, z * 0.01) * warpStrength;
    
    return multiOctaveNoise(noiseGen, x + warpX, z + warpZ, config);
}

// Define cube faces for geometry creation
const faces = [
    // Front face
    { 
        dir: [0, 0, 1], 
        vertices: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
    },
    // Back face
    { 
        dir: [0, 0, -1], 
        vertices: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]
    },
    // Right face
    { 
        dir: [1, 0, 0], 
        vertices: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]
    },
    // Left face
    { 
        dir: [-1, 0, 0], 
        vertices: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]
    },
    // Top face
    { 
        dir: [0, 1, 0], 
        vertices: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]
    },
    // Bottom face
    { 
        dir: [0, -1, 0], 
        vertices: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]
    }
];

// Names of the faces for texture mapping
const faceNames = ["front", "back", "right", "left", "top", "bottom"];

// Helper function to get block properties
function getBlockProperties(blockType) {
    if (!blockType) return null;
    // Convert block type number to name
    const blockName = Object.keys(BLOCK_TYPES).find(key => BLOCK_TYPES[key] === blockType);
    
    if (!blockColors) {
        return { transparency: 1, color: { r: 1, g: 1, b: 1 } }; // Default if blockColors not available
    }
    
    return blockColors[blockName] || { 
        transparency: 1,
        color: { r: 1, g: 1, b: 1 }
    };
}

// Helper function to get block name from type
function getBlockName(blockType) {
    return Object.keys(BLOCK_TYPES).find(key => BLOCK_TYPES[key] === blockType) || "unknown";
}

// Helper function to check if a face should be culled
function shouldCullFace(blockType, neighborType, neighborChunkLoaded) {
    // If the neighbor chunk isn't loaded, always cull that face
    if (!neighborChunkLoaded) return true;
    
    // If there's no neighbor block, don't cull
    if (!neighborType) return false;
    
    const blockProps = getBlockProperties(blockType);
    const neighborProps = getBlockProperties(neighborType);
    
    // If either block doesn't have properties, treat as opaque
    if (!blockProps || !neighborProps) return neighborType !== 0;
    
    // If the neighbor is the same block type, always cull
    if (blockType === neighborType) return true;
    
    // If the neighbor is transparent or see-through, don't cull unless it's the same block type
    if (neighborProps.transparency < 1 || neighborProps.seeThrough) return false;
    
    // Otherwise, cull if there's a neighbor block
    return true;
}

// Build Chunk Geometry function - moved from index.html to worker
function buildChunkGeometry(chunkData, cx, cz) {
    // Create separate arrays for each textured block type
    const texturedGeometries = {};
    const oVertices = [], oIndices = [], oUVs = [], oColors = [];
    let oVertexCount = 0;
    const tVertices = [], tIndices = [], tUVs = [], tColors = [];
    let tVertexCount = 0;

    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let y = 0; y < WORLD_HEIGHT; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                let blockType = chunkData[x][y][z];
                if (blockType === 0) continue;
                
                const blockName = getBlockName(blockType);
                const colObj = blockColors[blockName] || { color: { r: 1, g: 1, b: 1 }, transparency: 1 };

                for (let f = 0; f < faces.length; f++) {
                    const face = faces[f];
                    const faceName = faceNames[f];
                    const nx = x + face.dir[0];
                    const ny = y + face.dir[1];
                    const nz = z + face.dir[2];
                    
                    // Get the actual global coordinates for proper neighbor checking
                    const globalX = cx * CHUNK_SIZE + x;
                    const globalZ = cz * CHUNK_SIZE + z;
                    
                    // Check neighbor block using global coordinates
                    let neighbor = 0; // Default to air if out of bounds
                    let isNeighborChunkLoaded = true;
                    
                    if (ny < 0 || ny >= WORLD_HEIGHT) {
                        // Y out of bounds - treat as air
                        neighbor = 0;
                    } else if (nx < 0 || nx >= CHUNK_SIZE || nz < 0 || nz >= CHUNK_SIZE) {
                        // At chunk boundary - use global coordinates
                        const neighborGlobalX = globalX + face.dir[0];
                        const neighborGlobalZ = globalZ + face.dir[2];
                        const neighborCx = Math.floor(neighborGlobalX / CHUNK_SIZE);
                        const neighborCz = Math.floor(neighborGlobalZ / CHUNK_SIZE);
                        
                        // Check if neighbor chunk exists
                        const neighborKey = `${neighborCx},${neighborCz}`;
                        if (chunkStorage.has(neighborKey)) {
                            const neighborChunk = chunkStorage.get(neighborKey);
                            const neighborLocalX = ((neighborGlobalX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
                            const neighborLocalZ = ((neighborGlobalZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
                            neighbor = neighborChunk[neighborLocalX][ny][neighborLocalZ];
                        } else {
                            isNeighborChunkLoaded = false;
                        }
                    } else {
                        // Within same chunk and within bounds
                        neighbor = chunkData[nx][ny][nz];
                    }

                    // Check if this face should be culled
                    if (shouldCullFace(blockType, neighbor, isNeighborChunkLoaded)) {
                        continue;
                    }

                    // Check if this block has any textures at all
                    let hasFaceSpecificTexture = colObj.faces && colObj.faces[faceName] && colObj.faces[faceName].hasTexture;
                    let hasDefaultTexture = colObj.hasDefaultTexture;
                    
                    // For textured blocks, we'll add them based on block name and face
                    // Create separate geometry groups for face-specific textures vs default texture
                    if (hasFaceSpecificTexture || hasDefaultTexture) {
                        // Create geometry arrays for this block+face if they don't exist
                        const textureKey = blockName + (hasFaceSpecificTexture ? '_' + faceName : '');
                        if (!texturedGeometries[textureKey]) {
                            texturedGeometries[textureKey] = {
                                vertices: [],
                                indices: [],
                                uvs: [],
                                vertexCount: 0,
                                blockName: blockName,
                                faceName: hasFaceSpecificTexture ? faceName : null,
                                color: colObj.color || { r: 1, g: 1, b: 1 }
                            };
                        }

                        const geo = texturedGeometries[textureKey];
                        for (let i = 0; i < 4; i++) {
                            const v = face.vertices[i];
                            geo.vertices.push(
                                cx * CHUNK_SIZE + x + v[0],
                                y + v[1],
                                cz * CHUNK_SIZE + z + v[2]
                            );
                        }
                        
                        // Push UVs based on face
                        geo.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
                        
                        geo.indices.push(
                            geo.vertexCount, geo.vertexCount + 1, geo.vertexCount + 2,
                            geo.vertexCount, geo.vertexCount + 2, geo.vertexCount + 3
                        );
                        geo.vertexCount += 4;
                        continue;
                    }

                    // Handle non-textured faces
                    const baseColor = colObj.color || { r: 1, g: 1, b: 1 };
                    if (colObj.transparency === 1) {
                        for (let i = 0; i < 4; i++) {
                            const vertex = face.vertices[i];
                            oVertices.push(
                                cx * CHUNK_SIZE + x + vertex[0],
                                y + vertex[1],
                                cz * CHUNK_SIZE + z + vertex[2]
                            );
                            oColors.push(baseColor.r, baseColor.g, baseColor.b);
                        }
                        oUVs.push(0, 0, 1, 0, 1, 1, 0, 1);
                        oIndices.push(
                            oVertexCount, oVertexCount + 1, oVertexCount + 2,
                            oVertexCount, oVertexCount + 2, oVertexCount + 3
                        );
                        oVertexCount += 4;
                    } else {
                        for (let i = 0; i < 4; i++) {
                            const vertex = face.vertices[i];
                            tVertices.push(
                                cx * CHUNK_SIZE + x + vertex[0],
                                y + vertex[1],
                                cz * CHUNK_SIZE + z + vertex[2]
                            );
                            tColors.push(baseColor.r, baseColor.g, baseColor.b);
                        }
                        tUVs.push(0, 0, 1, 0, 1, 1, 0, 1);
                        tIndices.push(
                            tVertexCount, tVertexCount + 1, tVertexCount + 2,
                            tVertexCount, tVertexCount + 2, tVertexCount + 3
                        );
                        tVertexCount += 4;
                    }
                }
            }
        }
    }

    // Create array typed buffers for efficient transfer
    const geometryData = {
        opaque: {
            vertices: new Float32Array(oVertices),
            indices: new Uint32Array(oIndices),
            uvs: new Float32Array(oUVs),
            colors: new Float32Array(oColors)
        },
        transparent: {
            vertices: new Float32Array(tVertices),
            indices: new Uint32Array(tIndices),
            uvs: new Float32Array(tUVs),
            colors: new Float32Array(tColors)
        },
        textured: []
    };

    // Convert textured geometries to typed arrays
    for (const [key, geo] of Object.entries(texturedGeometries)) {
        geometryData.textured.push({
            key: key,
            vertices: new Float32Array(geo.vertices),
            indices: new Uint32Array(geo.indices),
            uvs: new Float32Array(geo.uvs),
            blockName: geo.blockName,
            faceName: geo.faceName,
            color: geo.color || { r: 1, g: 1, b: 1 } // Include color for fallback rendering
        });
    }

    return geometryData;
}

// Helper function to get block from chunk data, handling chunk boundaries
function getBlockFromChunks(globalX, y, globalZ) {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    
    const cx = Math.floor(globalX / CHUNK_SIZE);
    const cz = Math.floor(globalZ / CHUNK_SIZE);
    const key = `${cx},${cz}`;
    
    // Check if we have this chunk
    const chunk = chunkStorage.get(key);
    if (!chunk) return 0;
    
    const localX = ((globalX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localZ = ((globalZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    
    return chunk[localX][y][localZ];
}

// Helper function to check if a chunk is loaded
function isChunkLoaded(cx, cz) {
    return chunkStorage.has(`${cx},${cz}`);
}

// Noise generator (copied from main thread since we can't share functions)
var ImprovedNoise = function () {
    var seededRandom = seededRandomGenerator(worldSeed);
    var p = [];
    for (var i = 0; i < 256; i++) {
        p[i] = Math.floor(seededRandom() * 256);
    }
    var permutation = new Array(512);
    for (var i = 0; i < 256; i++) {
        permutation[i] = p[i];
        permutation[i + 256] = p[i];
    }
    function fade(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }
    function lerp(t, a, b) {
        return a + t * (b - a);
    }
    function grad(hash, x, y, z) {
        var h = hash & 15;
        var u = h < 8 ? x : y;
        var v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }
    return {
        noise: function (x, y, z) {
            var floorX = Math.floor(x), floorY = Math.floor(y), floorZ = Math.floor(z);
            var X = floorX & 255, Y = floorY & 255, Z = floorZ & 255;
            x -= floorX;
            y -= floorY;
            z -= floorZ;
            var u = fade(x), v = fade(y), w = fade(z);
            var A = permutation[X] + Y, AA = permutation[A] + Z, AB = permutation[A + 1] + Z;
            var B = permutation[X + 1] + Y, BA = permutation[B] + Z, BB = permutation[B + 1] + Z;
            return lerp(w,
                lerp(v,
                    lerp(u, grad(permutation[AA], x, y, z), grad(permutation[BA], x - 1, y, z)),
                    lerp(u, grad(permutation[AB], x, y - 1, z), grad(permutation[BB], x - 1, y - 1, z))
                ),
                lerp(v,
                    lerp(u, grad(permutation[AA + 1], x, y, z - 1), grad(permutation[BA + 1], x - 1, y, z - 1)),
                    lerp(u, grad(permutation[AB + 1], x, y - 1, z - 1), grad(permutation[BB + 1], x - 1, y - 1, z - 1))
                )
            );
        }
    };
};

// Copy of seededRandomGenerator since we need it for ImprovedNoise
function seededRandomGenerator(seed) {
    var m = 0x80000000;
    var a = 1103515245;
    var c = 12345;
    var g = 7499755 * seed / c;
    var u = c - seed * g;
    var state = seed ? seed : Math.floor(g * m % seed);
    return function() {
        state = (a * (state) + c) % m;
        return state / (m - 1);
    };
}

// New: Build raw geometry data for a chunk
function buildGeometryData(chunkData, cx, cz) {
    // Copy buildChunkGeometry logic but collect raw arrays
    const oVertices = [], oUVs = [], oColors = [], oIndices = [];
    const tVertices = [], tUVs = [], tColors = [], tIndices = [];
    const textured = [];

    // Loop over chunkData to build geometry
    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            for (let y = 0; y < WORLD_HEIGHT; y++) {
                const blockType = chunkData[x][y][z];
                if (blockType === 0) continue; // Skip empty blocks

                const properties = getBlockProperties(blockType);
                const isTransparent = properties && properties.transparency < 1;

                // Determine if we should cull faces based on neighbors
                const neighbors = [
                    { dx: 0, dy: 0, dz: 1 },   // Front
                    { dx: 0, dy: 0, dz: -1 },  // Back
                    { dx: 1, dy: 0, dz: 0 },   // Right
                    { dx: -1, dy: 0, dz: 0 },  // Left
                    { dx: 0, dy: 1, dz: 0 },   // Top
                    { dx: 0, dy: -1, dz: 0 }   // Bottom
                ];

                const faceCull = neighbors.map(dir => {
                    const nx = x + dir.dx, ny = y + dir.dy, nz = z + dir.dz;
                    const neighborType = (nx >= 0 && nz >= 0 && nx < CHUNK_SIZE && nz < CHUNK_SIZE) ? chunkData[nx][ny] && chunkData[nx][ny][nz] : 0;
                    return shouldCullFace(blockType, neighborType, isChunkLoaded(cx + dir.dx, cz + dir.dz));
                });

                // Push vertices, uvs, colors, indices for each face not culled
                const addFace = (verts, uvs, cols, inds, baseIndex) => {
                    const startIndex = verts.length / 3;
                    verts.push(...verts.slice(baseIndex * 3, baseIndex * 3 + 3));
                    uvs.push(...uvs.slice(baseIndex * 2, baseIndex * 2 + 2));
                    cols.push(...cols.slice(baseIndex * 4, baseIndex * 4 + 4));
                    inds.push(startIndex);
                };

                // Opaque and transparent face handling
                if (!isTransparent) {
                    // Handle opaque block faces
                    if (!faceCull[0]) addFace(oVertices, oUVs, oColors, oIndices, 0); // Front
                    if (!faceCull[1]) addFace(oVertices, oUVs, oColors, oIndices, 1); // Back
                    if (!faceCull[2]) addFace(oVertices, oUVs, oColors, oIndices, 2); // Right
                    if (!faceCull[3]) addFace(oVertices, oUVs, oColors, oIndices, 3); // Left
                    if (!faceCull[4]) addFace(oVertices, oUVs, oColors, oIndices, 4); // Top
                    if (!faceCull[5]) addFace(oVertices, oUVs, oColors, oIndices, 5); // Bottom
                } else {
                    // Handle transparent block faces
                    if (!faceCull[0]) addFace(tVertices, tUVs, tColors, tIndices, 0); // Front
                    if (!faceCull[1]) addFace(tVertices, tUVs, tColors, tIndices, 1); // Back
                    if (!faceCull[2]) addFace(tVertices, tUVs, tColors, tIndices, 2); // Right
                    if (!faceCull[3]) addFace(tVertices, tUVs, tColors, tIndices, 3); // Left
                    if (!faceCull[4]) addFace(tVertices, tUVs, tColors, tIndices, 4); // Top
                    if (!faceCull[5]) addFace(tVertices, tUVs, tColors, tIndices, 5); // Bottom
                }
            }
        }
    }

    // At end, return raw arrays
    return {
        opaque: { vertices: new Float32Array(oVertices), uvs: new Float32Array(oUVs), colors: new Float32Array(oColors), indices: new Uint32Array(oIndices) },
        transparent: { vertices: new Float32Array(tVertices), uvs: new Float32Array(tUVs), colors: new Float32Array(tColors), indices: new Uint32Array(tIndices) },
        textured // keep textureKey and raw arrays per entry
    };
}

// Main chunk generation function
function generateChunkData(cx, cz) {
    const startTime = performance.now();
    
    // Linear interpolation function
    function lerp(a, b, t) {
        return a * (1 - t) + b * t;
    }
    
    // Create a single noise generator instance for this chunk
    const noiseGenerator = new ImprovedNoise();
    
    // Seed-driven biome selection for consistent world generation
    function selectBiomeWithSeed(x, z, seed) {
        // Use multiple noise layers for natural biome distribution
        const currentBiomeScale = biomeScale || 0.0012;  // Use global biomeScale or default
        const detailScale = currentBiomeScale * 3.33;    // Proportional to biomeScale
        const warpScale = currentBiomeScale * 2.5;       // Proportional to biomeScale
        const tempScale = currentBiomeScale * 0.67;      // Proportional to biomeScale
        const moistScale = currentBiomeScale * 0.83;     // Proportional to biomeScale
        
        // Apply stronger domain warping for organic biome shapes
        const warpX = noiseGenerator.noise((x + seed) * warpScale, seed * 0.001, z * warpScale) * 400;
        const warpZ = noiseGenerator.noise(x * warpScale, (seed + 1000) * 0.001, (z + seed) * warpScale) * 400;
        
        const warpedX = x + warpX;
        const warpedZ = z + warpZ;
        
        // Generate multiple noise layers for complex biome patterns
        const biomeNoise1 = noiseGenerator.noise(warpedX * currentBiomeScale, seed * 0.01, warpedZ * currentBiomeScale);
        const biomeNoise2 = noiseGenerator.noise(warpedX * currentBiomeScale * 2.1, (seed + 100) * 0.01, warpedZ * currentBiomeScale * 2.1) * 0.5;
        const detailNoise = noiseGenerator.noise(warpedX * detailScale, (seed + 500) * 0.01, warpedZ * detailScale) * 0.3;
        const elevationNoise = noiseGenerator.noise(x * 0.001, (seed + 1500) * 0.01, z * 0.001);
        
        // Generate temperature and moisture values for biome compatibility
        const tempNoise = noiseGenerator.noise(x * tempScale, (seed + 2000) * 0.01, z * tempScale);
        const moistNoise = noiseGenerator.noise(x * moistScale, (seed + 3000) * 0.01, z * moistScale);
        
        // Simulate realistic temperature with wider range for more variety
        // Expand range from 30-110°F to 10-130°F for better biome differentiation
        const baseTemp = 70 + tempNoise * 60 - (elevationNoise > 0 ? elevationNoise * 40 : 0);
        // Expand moisture range slightly
        const moisture = Math.max(0, Math.min(1, 0.5 + moistNoise * 0.6));
        
        // Combine noises for complex biome selection
        const combinedNoise = biomeNoise1 + biomeNoise2 + detailNoise;
        const normalizedNoise = (combinedNoise + 1) / 2;
        
        // Create biome weight array based on rarity and environmental compatibility
        const biomeWeights = [];
        const biomeNames = Object.keys(BIOMES);
        
        for (const biomeName of biomeNames) {
            const biome = BIOMES[biomeName];
            // Use default size if not specified in edges
            const biomeSize = biome.edges && biome.edges.size ? biome.edges.size : 1.0;
            
            // Calculate environmental compatibility
            const tempDiff = Math.abs(baseTemp - biome.temperature);
            const moistDiff = Math.abs(moisture - biome.moisture);
            
            // Temperature compatibility - stricter ranges for better differentiation
            const tempCompatibility = Math.max(0.05, 1 - tempDiff / 60); // Allow within 60°F range
            // Moisture compatibility - stricter for better differentiation
            const moistCompatibility = Math.max(0.05, 1 - moistDiff / 0.6); // Allow within 0.6 moisture range
            
            // Environmental fitness
            const envFitness = (tempCompatibility + moistCompatibility) / 2;
            
            // Reduce dominance of high-rarity biomes and add diversity boost
            // Use cube root instead of square root to further reduce dominance
            // If rarity is not defined, default to 100 (common biome)
            const biomeRarity = biome.rarity !== undefined ? biome.rarity : 100;
            const rarityFactor = Math.pow(biomeRarity / 100, 0.33); // Cube root for more balance
            const diversityBoost = 0.5; // Base chance for all biomes
            
            // Final weight combines rarity, size, and environmental fitness
            // Prioritize environmental fitness over rarity for more varied biomes
            const weight = (rarityFactor * 0.4 + diversityBoost) * biomeSize * Math.pow(envFitness, 0.7);
            biomeWeights.push({ name: biomeName, weight: weight, biome: biome });
        }
        
        biomeWeights.sort((a, b) => b.weight - a.weight);
        
        // Calculate elevation for additional filtering
        const elevation = 65 + elevationNoise * 80;
        
        // Filter biomes by elevation compatibility (more lenient) and ensure minimum variety
        const suitableBiomes = biomeWeights.filter(item => {
            const heightDiff = Math.abs(elevation - item.biome.baseHeight);
            // More lenient filtering - allow more biomes or high-weight biomes
            return heightDiff < item.biome.heightVariation * 4.0 || item.weight > 0.5;
        });
        
        // Ensure we always have at least 3 biome options for variety
        if (suitableBiomes.length < 3) {
            // Add top biomes by weight until we have at least 3 options
            const additionalBiomes = biomeWeights.slice(0, Math.max(3, Math.min(5, biomeWeights.length)));
            for (const biome of additionalBiomes) {
                if (!suitableBiomes.find(s => s.name === biome.name)) {
                    suitableBiomes.push(biome);
                }
            }
        }
        
        if (suitableBiomes.length === 0) {
            return "plains";
        }
        
        // Use multiple selection methods for more variety
        const selectionMethod = Math.abs(biomeNoise1) % 1;
        
        if (selectionMethod < 0.4) {
            // Method 1: Weight-based selection using noise
            let totalWeight = 0;
            for (const item of suitableBiomes) {
                totalWeight += item.weight;
            }
            
            let target = normalizedNoise * totalWeight;
            for (const item of suitableBiomes) {
                target -= item.weight;
                if (target <= 0) {
                    return item.name;
                }
            }
        } else if (selectionMethod < 0.7) {
            // Method 2: Semi-random selection favoring rare biomes
            const randomFactor = Math.abs(detailNoise * combinedNoise);
            const index = Math.floor(randomFactor * Math.min(4, suitableBiomes.length));
            return suitableBiomes[index].name;
        } else {
            // Method 3: Pure environmental fitness selection
            suitableBiomes.sort((a, b) => {
                const aTempDiff = Math.abs(baseTemp - a.biome.temperature);
                const bTempDiff = Math.abs(baseTemp - b.biome.temperature);
                const aMoistDiff = Math.abs(moisture - a.biome.moisture);
                const bMoistDiff = Math.abs(moisture - b.biome.moisture);
                const aFitness = 1 / (aTempDiff + aMoistDiff + 1);
                const bFitness = 1 / (bTempDiff + bMoistDiff + 1);
                return bFitness - aFitness;
            });
            
            // Select from top 3 most environmentally suitable biomes
            const topCount = Math.min(3, suitableBiomes.length);
            const index = Math.floor(Math.abs(normalizedNoise * topCount));
            return suitableBiomes[index].name;
        }
        
        return suitableBiomes[0].name;
    }
    
    // Create biome and edge cache for this chunk
    const biomeCache = new Map();
    const edgeCache = new Map();
    
    // Pre-calculate biomes for the entire chunk area plus a buffer for edge detection
    // OPTIMIZATION: Reduced buffer size from 15 to 8 for faster calculation
    const BUFFER_SIZE = 8; // Buffer around chunk for edge detection
    const chunkStartX = cx * CHUNK_SIZE;
    const chunkStartZ = cz * CHUNK_SIZE;
    
    const biomeCalcStart = performance.now();
    // OPTIMIZATION: Calculate biomes at 2-block intervals and interpolate for smooth transitions
    const BIOME_SAMPLE_STEP = 2;
    for (let x = -BUFFER_SIZE; x < CHUNK_SIZE + BUFFER_SIZE; x += BIOME_SAMPLE_STEP) {
        for (let z = -BUFFER_SIZE; z < CHUNK_SIZE + BUFFER_SIZE; z += BIOME_SAMPLE_STEP) {
            const globalX = chunkStartX + x;
            const globalZ = chunkStartZ + z;
            const key = `${globalX},${globalZ}`;
            
            // Use seed-driven biome selection for consistent world generation
            const biomeKey = selectBiomeWithSeed(globalX, globalZ, worldSeed);
            biomeCache.set(key, biomeKey);
            
            // Fill in intermediate points with same biome for continuity
            if (BIOME_SAMPLE_STEP > 1) {
                for (let dx = 0; dx < BIOME_SAMPLE_STEP && x + dx < CHUNK_SIZE + BUFFER_SIZE; dx++) {
                    for (let dz = 0; dz < BIOME_SAMPLE_STEP && z + dz < CHUNK_SIZE + BUFFER_SIZE; dz++) {
                        if (dx === 0 && dz === 0) continue;
                        const interpKey = `${globalX + dx},${globalZ + dz}`;
                        biomeCache.set(interpKey, biomeKey);
                    }
                }
            }
            
            // Store in global biome storage for adjacency checking
            if (biomeStorage) {
                biomeStorage.set(key, biomeKey);
            }
        }
    }
    const biomeCalcTime = performance.now() - biomeCalcStart;
    
    // Enhanced biome transition and blending system
    function getBiomeWithTransitions(globalX, globalZ) {
        const baseBiome = getBiomeForChunk(globalX, globalZ);
        
        // Check if advanced terrain system is available for transitions
        if (!BIOME_ADJACENCY) {
            return baseBiome; // Fallback to simple biome
        }
        
        // Use a smaller, more efficient sampling pattern for performance
        const sampleOffsets = [
            [-20, 0], [20, 0], [0, -20], [0, 20],  // Cardinal directions
            [-15, -15], [15, -15], [-15, 15], [15, 15]  // Diagonals
        ];
        
        const nearbyBiomes = [];
        
        for (const [dx, dz] of sampleOffsets) {
            const nearbyBiome = getBiomeForChunk(globalX + dx, globalZ + dz);
            if (nearbyBiome !== baseBiome) {
                const distance = Math.sqrt(dx * dx + dz * dz);
                nearbyBiomes.push({ biome: nearbyBiome, distance: distance });
            }
        }
        
        if (nearbyBiomes.length === 0) {
            return baseBiome; // No transitions needed
        }
        
        // Find the closest incompatible biome (performance optimized)
        let closestIncompatible = null;
        let minDistance = Infinity;
        
        for (const nearby of nearbyBiomes) {
            if (getBiomeTransitionType(baseBiome, nearby.biome) === 'incompatible') {
                if (nearby.distance < minDistance) {
                    minDistance = nearby.distance;
                    closestIncompatible = nearby;
                }
            }
        }
        
        if (closestIncompatible && minDistance < 30) {
            // Create a transition zone using efficient noise sampling
            const transitionNoise = noiseGenerator.noise(globalX * 0.008, worldSeed * 0.001, globalZ * 0.008);
            const transitionStrength = (transitionNoise + 1) * 0.5; // 0 to 1
            
            // Insert transitional biome based on distance and noise
            const distanceFactor = 1 - (minDistance / 30);
            if (transitionStrength > (0.4 - distanceFactor * 0.2)) {
                // Select appropriate transition biome based on the incompatible biomes
                let transitionBiome = 'plains'; // Default
                
                if (baseBiome.includes('mountain') || closestIncompatible.biome.includes('mountain')) {
                    transitionBiome = 'hills';
                } else if (baseBiome.includes('desert') || closestIncompatible.biome.includes('desert')) {
                    transitionBiome = 'savanna';
                } else if (baseBiome.includes('ocean') || closestIncompatible.biome.includes('ocean')) {
                    transitionBiome = 'swamp';
                } else if (baseBiome.includes('snow') || closestIncompatible.biome.includes('snow')) {
                    transitionBiome = 'tundra';
                } else {
                    const options = ['plains', 'meadow', 'savanna'];
                    const index = Math.floor(transitionStrength * options.length);
                    transitionBiome = options[Math.min(index, options.length - 1)];
                }
                
                // Verify the transition biome exists and is compatible
                if (BIOMES[transitionBiome] && 
                    getBiomeTransitionType(baseBiome, transitionBiome) !== 'incompatible' &&
                    getBiomeTransitionType(transitionBiome, closestIncompatible.biome) !== 'incompatible') {
                    return transitionBiome;
                }
            }
        }
        
        return baseBiome;
    }
    
    // Create the data array with chunk coordinates
    const data = Array(CHUNK_SIZE).fill().map(() => 
        Array(WORLD_HEIGHT).fill().map(() => 
            Array(CHUNK_SIZE).fill(0)
        )
    );
    // Store chunk coordinates directly on the data object
    data.chunkX = cx;
    data.chunkZ = cz;

    // Optimized helper function to get biome with caching
    function getBiomeForChunk(globalX, globalZ) {
        const key = `${globalX},${globalZ}`;
        return biomeCache.get(key) || "ocean";
    }

    // Optimized helper function to check if a position is at the edge of its biome
    function isAtBiomeEdge(globalX, globalZ) {
        const currentBiomeKey = getBiomeForChunk(globalX, globalZ);
        const currentBiome = BIOMES[currentBiomeKey];
        
        // Use cache for edge detection
        const key = `${globalX},${globalZ}`;
        if (edgeCache.has(key)) {
            return edgeCache.get(key);
        }
        
        // Simplified edge detection - check wider area for better blending
        const checkRadius = Math.min(8, currentBiome.edges ? Math.ceil(currentBiome.edges.size * 50) : 4);
        
        // Check only cardinal and diagonal directions for performance
        const checkPoints = [
            [-checkRadius, 0], [checkRadius, 0], [0, -checkRadius], [0, checkRadius],
            [-checkRadius, -checkRadius], [-checkRadius, checkRadius], 
            [checkRadius, -checkRadius], [checkRadius, checkRadius]
        ];
        
        for (const [dx, dz] of checkPoints) {
            const nearbyBiomeKey = getBiomeForChunk(globalX + dx, globalZ + dz);
            if (nearbyBiomeKey !== currentBiomeKey) {
                const result = {
                    isEdge: true,
                    nearbyBiomeKey: nearbyBiomeKey,
                    edgeDistance: Math.min(Math.abs(dx), Math.abs(dz)) / checkRadius
                };
                edgeCache.set(key, result);
                return result;
            }
        }
        
        const result = { isEdge: false };
        edgeCache.set(key, result);
        return result;
    }
    
    // Enhanced helper function to get height - uses sophisticated system when available
    function getHeightWithBiomeForChunk(globalX, globalZ) {
        const currentBiomeKey = getBiomeForChunk(globalX, globalZ);
        const currentBiome = BIOMES[currentBiomeKey];
        
        // If advanced terrain system is available, use it
        if (NOISE_CONFIG && TERRAIN_BOUNDS && GEOLOGICAL_FORMATIONS) {
            // OPTIMIZATION: Reduced nearby biome sampling from 5x5 grid to sparse sampling
            const nearbyBiomes = [];
            const sampleOffsets = [
                [-100, 0], [100, 0], [0, -100], [0, 100],  // Cardinal only for speed
                [-70, -70], [70, 70]  // Just 2 diagonals instead of 4
            ];
            
            for (const [dx, dz] of sampleOffsets) {
                const nearbyBiome = getBiomeForChunk(globalX + dx, globalZ + dz);
                if (nearbyBiome !== currentBiomeKey) {
                    nearbyBiomes.push({
                        biome: nearbyBiome,
                        x: globalX + dx,
                        z: globalZ + dz
                    });
                }
            }
            
            return calculateSophisticatedHeight(globalX, globalZ, currentBiomeKey, noiseGenerator, nearbyBiomes);
        }
        
        // Check if we're near a biome boundary and need height blending
        const edgeInfo = isAtBiomeEdge(globalX, globalZ);
        if (edgeInfo.isEdge && edgeInfo.nearbyBiomeKey && edgeInfo.edgeDistance < 16) {
            const nearbyBiome = BIOMES[edgeInfo.nearbyBiomeKey];
            const currentHeight = calculateBasicHeightForBiome(globalX, globalZ, currentBiome, currentBiomeKey);
            const nearbyHeight = calculateBasicHeightForBiome(globalX, globalZ, nearbyBiome, edgeInfo.nearbyBiomeKey);
            
            // Enhanced blending - check multiple nearby points for smoother transitions
            let totalHeight = currentHeight;
            let totalWeight = 1.0;
            
            // OPTIMIZATION: Reduced sample points from 8 to 4 for faster blending
            const samplePoints = [
                [-8, 0], [8, 0], [0, -8], [0, 8]
            ];
            
            for (const [dx, dz] of samplePoints) {
                const sampleX = globalX + dx;
                const sampleZ = globalZ + dz;
                const sampleBiomeKey = getBiomeForChunk(sampleX, sampleZ);
                
                if (sampleBiomeKey !== currentBiomeKey) {
                    const sampleBiome = BIOMES[sampleBiomeKey];
                    const sampleHeight = calculateBasicHeightForBiome(sampleX, sampleZ, sampleBiome, sampleBiomeKey);
                    const distance = Math.sqrt(dx * dx + dz * dz);
                    const weight = Math.max(0, 1 - distance / 16);
                    
                    totalHeight += sampleHeight * weight;
                    totalWeight += weight;
                }
            }
            
            return Math.floor(totalHeight / totalWeight);
        }
        
        // Fallback to existing height calculation system
        return calculateBasicHeightForBiome(globalX, globalZ, currentBiome, currentBiomeKey);
    }
    
    // Helper function for basic height calculation
    function calculateBasicHeightForBiome(globalX, globalZ, biome, biomeKey) {
        const edgeInfo = isAtBiomeEdge(globalX, globalZ);
        const hasEdgeProperties = biome.edges !== undefined;
        
        // Decide whether to use edge properties and how much to blend
        let biomeToUse;
        
        if (edgeInfo.isEdge && hasEdgeProperties) {
            // Calculate blend factor (simplified)
            const blendFactor = biome.edges.blend ? 
                Math.min(1, edgeInfo.edgeDistance * (biome.edges.blend * 0.1)) : 
                edgeInfo.edgeDistance;
            
            // Pre-calculate blended values
            biomeToUse = {
                baseHeight: lerp(biome.edges.baseHeight, biome.baseHeight, blendFactor),
                heightVariation: lerp(biome.edges.heightVariation, biome.heightVariation, blendFactor),
                frequency: biome.edges.frequency || biome.frequency
            };
        } else {
            biomeToUse = biome;
        }
        
        // Enhanced transition calculation with multi-octave noise
        if (biome.transition === "None") {
            // Generate multiple octaves of noise for more natural terrain
            const scale1 = biomeToUse.frequency;
            const scale2 = biomeToUse.frequency * 2.5;
            const scale3 = biomeToUse.frequency * 6.0;
            const scale4 = biomeToUse.frequency * 15.0;
            
            // Primary terrain shape (large features)
            const noise1 = noiseGenerator.noise(globalX * scale1, 0, globalZ * scale1);
            // Secondary terrain variation (medium features)
            const noise2 = noiseGenerator.noise(globalX * scale2, 100, globalZ * scale2) * 0.5;
            // Tertiary detail (small features)
            const noise3 = noiseGenerator.noise(globalX * scale3, 200, globalZ * scale3) * 0.25;
            // Fine detail (micro features)
            const noise4 = noiseGenerator.noise(globalX * scale4, 300, globalZ * scale4) * 0.125;
            
            // Combine octaves with different weights based on biome type
            let combinedNoise;
            if (biomeKey.includes('mountain') || biomeKey.includes('peaks') || biomeKey.includes('hills')) {
                // Mountains need more dramatic height variation
                combinedNoise = noise1 + noise2 * 0.8 + noise3 * 0.4 + noise4 * 0.2;
            } else if (biomeKey.includes('plains') || biomeKey.includes('meadow')) {
                // Plains should be smoother
                combinedNoise = noise1 * 0.7 + noise2 * 0.3 + noise3 * 0.15 + noise4 * 0.1;
            } else if (biomeKey.includes('desert') || biomeKey.includes('dunes')) {
                // Deserts have rolling dunes
                combinedNoise = noise1 * 0.8 + noise2 * 0.6 + noise3 * 0.2 + noise4 * 0.1;
            } else if (biomeKey.includes('ocean') || biomeKey.includes('lake')) {
                // Water areas should be relatively flat with subtle variation
                combinedNoise = noise1 * 0.5 + noise2 * 0.2 + noise3 * 0.1 + noise4 * 0.05;
            } else {
                // Default balanced combination
                combinedNoise = noise1 + noise2 * 0.5 + noise3 * 0.25 + noise4 * 0.125;
            }
            
            return Math.floor(biomeToUse.baseHeight + combinedNoise * biomeToUse.heightVariation);
        } else {
            // Enhanced blending for smoother transitions
            const blendRadius = (biome.transition === "Full") ? 8 : 4;
            let sumHeights = 0;
            let totalWeight = 0;
            
            // Use a step size to reduce calculations
            const step = Math.max(1, Math.floor(blendRadius / 4));
            
            for (let dx = -blendRadius; dx <= blendRadius; dx += step) {
                for (let dz = -blendRadius; dz <= blendRadius; dz += step) {
                    const sampleBiomeKey = getBiomeForChunk(globalX + dx, globalZ + dz);
                    const sampleBiome = BIOMES[sampleBiomeKey];
                    
                    // Enhanced sampling with multiple octaves for each sample point
                    let sampleBiomeToUse = sampleBiome;
                    
                    // Only check for edge properties if the sample biome has them
                    if (sampleBiome.edges) {
                        const sampleEdgeInfo = isAtBiomeEdge(globalX + dx, globalZ + dz);
                        if (sampleEdgeInfo.isEdge) {
                            const sampleBlendFactor = sampleBiome.edges.blend ? 
                                Math.min(1, sampleEdgeInfo.edgeDistance * (sampleBiome.edges.blend * 0.1)) : 
                                sampleEdgeInfo.edgeDistance;
                            
                            sampleBiomeToUse = {
                                baseHeight: lerp(sampleBiome.edges.baseHeight, sampleBiome.baseHeight, sampleBlendFactor),
                                heightVariation: lerp(sampleBiome.edges.heightVariation, sampleBiome.heightVariation, sampleBlendFactor),
                                frequency: sampleBiome.edges.frequency || sampleBiome.frequency
                            };
                        }
                    }
                    
                    // Multi-octave noise for sample points too
                    const sScale1 = sampleBiomeToUse.frequency;
                    const sScale2 = sampleBiomeToUse.frequency * 2.5;
                    const sScale3 = sampleBiomeToUse.frequency * 6.0;
                    
                    const sNoise1 = noiseGenerator.noise((globalX + dx) * sScale1, 0, (globalZ + dz) * sScale1);
                    const sNoise2 = noiseGenerator.noise((globalX + dx) * sScale2, 100, (globalZ + dz) * sScale2) * 0.5;
                    const sNoise3 = noiseGenerator.noise((globalX + dx) * sScale3, 200, (globalZ + dz) * sScale3) * 0.25;
                    
                    let sCombinedNoise;
                    if (sampleBiomeKey.includes('mountain') || sampleBiomeKey.includes('peaks') || sampleBiomeKey.includes('hills')) {
                        sCombinedNoise = sNoise1 + sNoise2 * 0.8 + sNoise3 * 0.4;
                    } else if (sampleBiomeKey.includes('plains') || sampleBiomeKey.includes('meadow')) {
                        sCombinedNoise = sNoise1 * 0.7 + sNoise2 * 0.3 + sNoise3 * 0.15;
                    } else if (sampleBiomeKey.includes('ocean') || sampleBiomeKey.includes('lake')) {
                        sCombinedNoise = sNoise1 * 0.5 + sNoise2 * 0.2 + sNoise3 * 0.1;
                    } else {
                        sCombinedNoise = sNoise1 + sNoise2 * 0.5 + sNoise3 * 0.25;
                    }
                    
                    const sampleHeight = sampleBiomeToUse.baseHeight + sCombinedNoise * sampleBiomeToUse.heightVariation;
                    const distance = Math.sqrt(dx * dx + dz * dz);
                    // Enhanced weight calculation for smoother blending
                    const weight = Math.max(0.1, Math.pow(blendRadius - distance + 1, 1.5));
                    sumHeights += sampleHeight * weight;
                    totalWeight += weight;
                }
            }
            return Math.floor(sumHeights / totalWeight);
        }
    }

    // Generate terrain - enhanced with smooth biome transitions
    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const globalX = cx * CHUNK_SIZE + x;
            const globalZ = cz * CHUNK_SIZE + z;
            
            // Use enhanced biome selection with transitions
            const biomeKey = getBiomeWithTransitions(globalX, globalZ);
            const biome = BIOMES[biomeKey];
            let h = getHeightWithBiomeForChunk(globalX, globalZ);
            
            // Additional height smoothing for better biome alignment
            // OPTIMIZATION: Only smooth at actual edges, and reduce sampling
            const edgeInfo = isAtBiomeEdge(globalX, globalZ);
            if (edgeInfo.isEdge && edgeInfo.nearbyBiomeKey) {
                const nearbyBiome = BIOMES[edgeInfo.nearbyBiomeKey];
                const currentBaseHeight = biome.baseHeight;
                const nearbyBaseHeight = nearbyBiome.baseHeight;
                
                // If there's a significant height difference, apply extra smoothing
                const heightDiff = Math.abs(currentBaseHeight - nearbyBaseHeight);
                if (heightDiff > 5) { // OPTIMIZATION: Only smooth significant differences (was 2)
                    // OPTIMIZATION: Reduced sample radius from 2 to 1 for faster smoothing
                    let smoothSum = h;
                    let smoothCount = 1;
                    
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            if (dx === 0 && dz === 0) continue;
                            
                            const sampleX = globalX + dx;
                            const sampleZ = globalZ + dz;
                            const sampleBiomeKey = getBiomeForChunk(sampleX, sampleZ);
                            
                            if (sampleBiomeKey === biomeKey || sampleBiomeKey === edgeInfo.nearbyBiomeKey) {
                                const sampleHeight = getHeightWithBiomeForChunk(sampleX, sampleZ);
                                const distance = Math.sqrt(dx * dx + dz * dz);
                                const weight = Math.max(0, 1 - distance / 2); // OPTIMIZATION: Adjusted weight for new radius
                                
                                smoothSum += sampleHeight * weight;
                                smoothCount += weight;
                            }
                        }
                    }
                    
                    h = Math.floor(smoothSum / smoothCount);
                }
            }
            
            // Get edge info once (it's cached now)
            const updatedEdgeInfo = isAtBiomeEdge(globalX, globalZ);
            
            // Enhanced layer blending for smooth transitions
            let layersToUse = biome.layers;
            let defaultLayerToUse = biome.defaultLayer;
            
            // Check for biome transition blending
            if (BIOME_ADJACENCY && updatedEdgeInfo.isEdge) {
                const nearbyBiomeKey = updatedEdgeInfo.nearbyBiomeKey;
                const transitionType = getBiomeTransitionType(biomeKey, nearbyBiomeKey);
                
                if (transitionType === 'buffered' || transitionType === 'direct') {
                    const nearbyBiome = BIOMES[nearbyBiomeKey];
                    const blendFactor = Math.min(0.5, updatedEdgeInfo.edgeDistance);
                    
                    // Blend layers between biomes for smoother transitions
                    if (nearbyBiome && nearbyBiome.layers && Math.random() < blendFactor) {
                        // Occasionally use nearby biome's layers for natural mixing
                        if (nearbyBiome.layers.length > 0 && biome.layers.length > 0) {
                            // Mix the top layers
                            layersToUse = [...biome.layers];
                            if (layersToUse.length > 0 && nearbyBiome.layers.length > 0) {
                                layersToUse[0] = nearbyBiome.layers[0]; // Use nearby biome's top layer
                            }
                        }
                    }
                }
            }
            
            if (updatedEdgeInfo.isEdge && biome.edges) {
                // If we're using edge properties, check if we should use the edge's layers or default ones
                if (biome.edges.layers && biome.edges.layers !== "default") {
                    layersToUse = biome.edges.layers;
                }
                
                if (biome.edges.defaultLayer && biome.edges.defaultLayer !== "default") {
                    defaultLayerToUse = biome.edges.defaultLayer;
                }
            }

            // Fill terrain layers - optimized
            let remaining = h;
            if (layersToUse && Array.isArray(layersToUse) && layersToUse.length > 0) {
                for (let i = 0; i < layersToUse.length && remaining > 0; i++) {
                    const layer = layersToUse[i];
                    let thickness = 0;
                    const thicknessDef = layer.number;
                    
                    if (typeof thicknessDef === "string") {
                        if (thicknessDef.includes("-")) {
                            const [min, max] = thicknessDef.split("-").map(Number);
                            thickness = Math.floor(Math.random() * (max - min + 1)) + min;
                        } else {
                            thickness = parseInt(thicknessDef);
                        }
                    } else {
                        thickness = thicknessDef;
                    }
                    
                    thickness = Math.min(thickness, remaining);
                    const blockType = BLOCK_TYPES[layer.type];
                    
                    // OPTIMIZATION: Use fill() when possible for consecutive blocks
                    const startY = remaining - thickness;
                    const endY = remaining;
                    
                    if (startY >= 0 && endY <= WORLD_HEIGHT) {
                        // Batch fill the layer
                        for (let y = startY; y < endY; y++) {
                            data[x][y][z] = blockType;
                        }
                    } else {
                        // Boundary check for edge cases
                        for (let y = startY; y < endY; y++) {
                            if (y >= 0 && y < WORLD_HEIGHT) {
                                data[x][y][z] = blockType;
                            }
                        }
                    }
                    remaining -= thickness;
                }
            }
            
            // OPTIMIZATION: Fill remaining with default layer using batch operation
            const defaultBlockType = BLOCK_TYPES[defaultLayerToUse];
            if (remaining > 0 && defaultBlockType !== undefined) {
                for (let y = 0; y < remaining; y++) {
                    if (y < WORLD_HEIGHT) {
                        data[x][y][z] = defaultBlockType;
                    }
                }
            }

            // Handle water fill for ocean biomes - optimized
            if (biome.fill) {
                const fillHeight = Math.min(biome.fill.height, WORLD_HEIGHT);
                const fillBlockType = BLOCK_TYPES[biome.fill.type];
                for (let y = 0; y < fillHeight; y++) {
                    if (data[x][y][z] === 0) {
                        data[x][y][z] = fillBlockType;
                    }
                }
            }

            // Generate structures based on biome - optimized
            // OPTIMIZATION: Pre-calculate structure probability to avoid unnecessary calls
            if (biome.structures && biome.structures.length > 0 && StructureGenerators) {
                const structureRoll = Math.random() * 100; // Single random roll
                let cumulativeProbability = 0;
                
                for (let i = 0; i < biome.structures.length; i++) {
                    const structure = biome.structures[i];
                    cumulativeProbability += structure.frequency;
                    
                    // Check if this structure should generate based on cumulative probability
                    if (structureRoll < cumulativeProbability && StructureGenerators[structure.type]) {
                        StructureGenerators[structure.type](data, x, h, z);
                        break; // Only place one structure per column for performance
                    }
                }
            }
        }
    }

    // Store chunk in storage for neighbor lookups
    chunkStorage.set(`${cx},${cz}`, data);

    // Check if we need to update any neighboring chunks
    const neighbors = [
        [cx - 1, cz], [cx + 1, cz],
        [cx, cz - 1], [cx, cz + 1]
    ];
    
    // Queue updates for neighbors if they exist
    for (const [ncx, ncz] of neighbors) {
        const nKey = `${ncx},${ncz}`;
        if (chunkStorage.has(nKey)) {
            self.postMessage({
                type: "chunkUpdated",
                cx: ncx,
                cz: ncz,
                chunkData: chunkStorage.get(nKey)
            });
        }
    }

    const totalTime = performance.now() - startTime;
    
    // OPTIMIZATION: Performance metrics logging
    const cacheHitRate = noiseCacheMisses > 0 ? 
        ((noiseCacheHits / (noiseCacheHits + noiseCacheMisses)) * 100).toFixed(1) : 0;
    
    if (totalTime > 100) { // Only log slow chunks
        console.log(`⚡ Chunk (${cx},${cz}) generated in ${totalTime.toFixed(1)}ms | Biome calc: ${biomeCalcTime.toFixed(1)}ms | Cache hit rate: ${cacheHitRate}%`);
    } else if (totalTime < 20) { // Log fast chunks occasionally
        if (Math.random() < 0.05) { // 5% sampling
            console.log(`🚀 FAST chunk (${cx},${cz}) generated in ${totalTime.toFixed(1)}ms | Cache hit rate: ${cacheHitRate}%`);
        }
    }

    return data;
}

// Message handler
self.onmessage = function(e) {
    const { cx, cz, constants, type, modifiedChunk, requestGeometry, isPriority } = e.data;
    
    // Priority chunks bypass normal queue processing (handled immediately)
    // This ensures modified chunks update instantly for better user experience
    
    if (type === "updateChunk") {
        // Store modified chunk data
        const key = `${cx},${cz}`;
        chunkStorage.set(key, modifiedChunk);
        
        // Update neighboring chunks in storage
        const neighbors = [
            [cx - 1, cz], [cx + 1, cz],
            [cx, cz - 1], [cx, cz + 1]
        ];
        
        // Queue updates for all affected chunks
        const chunksToUpdate = new Set([key]);
        for (const [ncx, ncz] of neighbors) {
            const nKey = `${ncx},${ncz}`;
            if (chunkStorage.has(nKey)) {
                chunksToUpdate.add(nKey);
            }
        }
        
        // Send updates for all affected chunks
        for (const chunkKey of chunksToUpdate) {
            const [updateCx, updateCz] = chunkKey.split(',').map(Number);
            const chunkToUpdate = chunkStorage.get(chunkKey);
            if (chunkToUpdate) {
                // Build geometry data and send it back
                const geometryData = buildChunkGeometry(chunkToUpdate, updateCx, updateCz);
                self.postMessage({
                    type: "chunkUpdated",
                    cx: updateCx,
                    cz: updateCz,
                    geometryData: geometryData
                }, [
                    geometryData.opaque.vertices.buffer,
                    geometryData.opaque.indices.buffer,
                    geometryData.opaque.uvs.buffer,
                    geometryData.opaque.colors.buffer,
                    geometryData.transparent.vertices.buffer,
                    geometryData.transparent.indices.buffer,
                    geometryData.transparent.uvs.buffer,
                    geometryData.transparent.colors.buffer
                ]);
            }
        }
        return;
    }
    
    // Set up constants received from main thread
    if (constants) {
        CHUNK_SIZE = constants.CHUNK_SIZE;
        WORLD_HEIGHT = constants.WORLD_HEIGHT;
        BLOCK_TYPES = constants.BLOCK_TYPES;
        BIOMES = constants.BIOMES;
        worldSeed = constants.worldSeed;
        blockColors = constants.blockColors;
        biomeScale = constants.biomeScale || 0.0012; // Default value if not provided
        
        // Advanced terrain system constants
        BIOME_ADJACENCY = constants.BIOME_ADJACENCY;
        GEOLOGICAL_FORMATIONS = constants.GEOLOGICAL_FORMATIONS;
        TERRAIN_BOUNDS = constants.TERRAIN_BOUNDS;
        NOISE_CONFIG = constants.NOISE_CONFIG;
        
        // Initialize advanced noise generator
        if (constants.AdvancedNoiseGenerator) {
            // Reconstruct the AdvancedNoiseGenerator class from string
            AdvancedNoiseGenerator = new Function('ImprovedNoise', 'return ' + constants.AdvancedNoiseGenerator)(ImprovedNoise);
        }
        
        // Convert string functions back to actual functions
        StructureGenerators = {};
        if (constants.StructureGenerators) {
            for (const [key, fnString] of Object.entries(constants.StructureGenerators)) {
                StructureGenerators[key] = new Function('return ' + fnString)();
            }
        }
    }

    // Check if we have this chunk stored
    const key = `${cx},${cz}`;
    let chunkData = chunkStorage.get(key);
    
    // If not in storage, generate new chunk
    if (!chunkData) {
        chunkData = generateChunkData(cx, cz);
        chunkStorage.set(key, chunkData);
        
        // Build geometry data in the worker
        const geometryData = buildChunkGeometry(chunkData, cx, cz);
        
        // Get all neighboring chunks that need updating - only send if needed
        const neighbors = [
            [cx - 1, cz], [cx + 1, cz],
            [cx, cz - 1], [cx, cz + 1]
        ];
        
        // Transfer the typed arrays to avoid copying the data
        // Send both chunk data and geometry data for new chunks
        self.postMessage({ 
            cx, 
            cz, 
            chunkData,
            geometryData
        }, [
            geometryData.opaque.vertices.buffer,
            geometryData.opaque.indices.buffer,
            geometryData.opaque.uvs.buffer,
            geometryData.opaque.colors.buffer,
            geometryData.transparent.vertices.buffer,
            geometryData.transparent.indices.buffer,
            geometryData.transparent.uvs.buffer,
            geometryData.transparent.colors.buffer
        ]);
        
        // Then update all existing neighbors that might need re-rendering
        for (const [ncx, ncz] of neighbors) {
            const nKey = `${ncx},${ncz}`;
            if (chunkStorage.has(nKey)) {
                const neighborData = chunkStorage.get(nKey);
                const neighborGeom = buildChunkGeometry(neighborData, ncx, ncz);
                
                self.postMessage({
                    type: "chunkUpdated",
                    cx: ncx,
                    cz: ncz,
                    geometryData: neighborGeom
                }, [
                    neighborGeom.opaque.vertices.buffer,
                    neighborGeom.opaque.indices.buffer,
                    neighborGeom.opaque.uvs.buffer,
                    neighborGeom.opaque.colors.buffer,
                    neighborGeom.transparent.vertices.buffer,
                    neighborGeom.transparent.indices.buffer,
                    neighborGeom.transparent.uvs.buffer,
                    neighborGeom.transparent.colors.buffer
                ]);
            }
        }
        return;
    }
    
    // If geometry was requested, build and return it
    if (requestGeometry) {
        const geometryData = buildChunkGeometry(chunkData, cx, cz);
        
        self.postMessage({ 
            cx, 
            cz, 
            geometryData 
        }, [
            geometryData.opaque.vertices.buffer,
            geometryData.opaque.indices.buffer,
            geometryData.opaque.uvs.buffer,
            geometryData.opaque.colors.buffer,
            geometryData.transparent.vertices.buffer,
            geometryData.transparent.indices.buffer,
            geometryData.transparent.uvs.buffer,
            geometryData.transparent.colors.buffer
        ]);
    } else {
        // Just send the chunk data, legacy behavior
        self.postMessage({ cx, cz, chunkData });
    }
};

// Helper to enforce biome spacing rule (no same biome within MIN_DIST)
function isSameBiomeNearby(biomeName, x, z) {
    const MIN_DIST = 50;
    const checkOffsets = [[MIN_DIST, 0], [-MIN_DIST, 0], [0, MIN_DIST], [0, -MIN_DIST]];
    for (const [dx, dz] of checkOffsets) {
        const key = `${x + dx},${z + dz}`;
        if (biomeStorage.get(key) === biomeName) {
            return true;
        }
    }
    return false;
}

// After biomeCache building and timing, apply smoothing to remove small spikes (smooth edges)
{
    const smoothed = new Map();
    for (let [key, biomeKey] of biomeCache.entries()) {
        const [gx, gz] = key.split(',').map(Number);
        const neighbors = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (dx === 0 && dz === 0) continue;
                const nKey = `${gx + dx},${gz + dz}`;
                if (biomeCache.has(nKey)) neighbors.push(biomeCache.get(nKey));
            }
        }
        // count frequencies
        const freq = {};
        neighbors.forEach(b => { freq[b] = (freq[b] || 0) + 1; });
        // determine majority
        let majority = biomeKey;
        let maxCount = freq[biomeKey] || 0;
        for (const [b, count] of Object.entries(freq)) {
            if (count > maxCount) {
                majority = b;
                maxCount = count;
            }
        }
        // only replace isolated spikes (majority more than half of neighbors)
        if (maxCount >= 5) {
            smoothed.set(key, majority);
        } else {
            smoothed.set(key, biomeKey);
        }
    }
    // update biomeCache and global storage
    biomeStorage.clear();
    biomeCache.clear();
    for (const [key, b] of smoothed.entries()) {
        biomeCache.set(key, b);
        biomeStorage.set(key, b);
    }
}
/**
 * Procedural 3D Noise Generator on CPU
 * Optimized to avoid blocking the main thread by pre-calculating hashes.
 */
const NoiseGenerator = {
    // Pre-calculated array of hashes to avoid costly Math.sin calls
    // 256 values (0-255) x 3 dimensions
    _hashTable: null,

    _initHashTable() {
        if (this._hashTable) return;
        this._hashTable = new Float32Array(256 * 3);
        
        for (let i = 0; i < 256; i++) {
            // Pseudo-random generation based on index
            const p1 = Math.sin(i * 12.9898) * 43758.5453;
            const p2 = Math.sin(i * 39.346) * 43758.5453;
            const p3 = Math.sin(i * 73.156) * 43758.5453;
            
            this._hashTable[i * 3 + 0] = p1 - Math.floor(p1);
            this._hashTable[i * 3 + 1] = p2 - Math.floor(p2);
            this._hashTable[i * 3 + 2] = p3 - Math.floor(p3);
        }
    },

    /**
     * Fast 3D hash retrieval using the pre-calculated table and a simple mix hash function.
     */
    _fastHash3(x, y, z) {
        // Mix x, y, z to get a pseudo-random but deterministic index (0-255)
        const h = (x * 73856093 ^ y * 19349663 ^ z * 83492791) & 255;
        const idx = h * 3;
        
        return {
            x: this._hashTable[idx],
            y: this._hashTable[idx + 1],
            z: this._hashTable[idx + 2]
        };
    },

    /**
     * Inverted 3D Worley Noise (Seamless/Tileable).
     */
    _worleyNoise(x, y, z, period) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const iz = Math.floor(z);

        // Squared Euclidean distance (faster than using Math.sqrt in the inner loop)
        let minSqDist = 10.0; 

        // Check current cell and 26 neighbors (3x3x3)
        for (let k = -1; k <= 1; k++) {
            for (let j = -1; j <= 1; j++) {
                for (let i = -1; i <= 1; i++) {
                    const cx = ix + i;
                    const cy = iy + j;
                    const cz = iz + k;

                    // Wrapping for tileability (Seamless boundary conditions)
                    const wcx = ((cx % period) + period) % period;
                    const wcy = ((cy % period) + period) % period;
                    const wcz = ((cz % period) + period) % period;

                    // Pseudo-random seed point within the wrapped cell
                    const hash = this._fastHash3(wcx, wcy, wcz);
                    
                    // Absolute position of the seed point
                    const px = cx + hash.x;
                    const py = cy + hash.y;
                    const pz = cz + hash.z;

                    const dx = x - px;
                    const dy = y - py;
                    const dz = z - pz;
                    
                    const sqDist = dx * dx + dy * dy + dz * dz;
                    if (sqDist < minSqDist) {
                        minSqDist = sqDist;
                    }
                }
            }
        }
        
        // Invert the distance to create "bubbles" (0 at the edge, 1 in the center)
        // Use Math.sqrt only once at the end for performance
        return Math.max(0.0, 1.0 - Math.sqrt(minSqDist));
    },

    /**
     * Generates a 3D volume of Fractal Worley Noise (FBM).
     * @param {number} size 3D texture resolution (e.g., 64, 128)
     * @param {number} baseFreq Base noise frequency (determines initial "period")
     * @param {number} octaves Number of stacked noise layers
     * @returns {Uint8Array} Texture data in R8 format
     */
    generate3DTexture(size, baseFreq, octaves) {
        this._initHashTable();

        console.time(`[NoiseGenerator] Baked Vol. ${size}³ (Freq:${baseFreq}, Oct:${octaves})`);
        
        const data = new Uint8Array(size * size * size);
        const invSize = 1.0 / size;
        let index = 0;

        for (let z = 0; z < size; z++) {
            const nz = z * invSize;
            for (let y = 0; y < size; y++) {
                const ny = y * invSize;
                for (let x = 0; x < size; x++) {
                    const nx = x * invSize;

                    let noiseVal = 0;
                    let amplitude = 1.0;
                    let frequency = baseFreq;
                    let maxValue = 0;
                    
                    // FBM (Fractal Brownian Motion) accumulation
                    for (let o = 0; o < octaves; o++) {
                        const period = Math.floor(frequency);
                        const w = this._worleyNoise(nx * frequency, ny * frequency, nz * frequency, period);
                        
                        noiseVal += amplitude * w;
                        maxValue += amplitude;
                        
                        // Prepare next octave (higher frequency, lower amplitude)
                        amplitude *= 0.5;
                        frequency *= 2.0;
                    }

                    // Normalize FBM result to [0, 1] range, then map to Uint8 [0, 255]
                    data[index++] = (noiseVal / maxValue) * 255.0;
                }
            }
        }
        
        console.timeEnd(`[NoiseGenerator] Baked Vol. ${size}³ (Freq:${baseFreq}, Oct:${octaves})`);
        return data;
    }
};
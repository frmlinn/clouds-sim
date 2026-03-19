# clouds-sim

About a year ago, I stumbled upon [Sebastian Lague](https://www.youtube.com/@SebastianLague)’s fantastic and highly educational YouTube channel. I was immediately struck by the elegant simplicity of the solutions he implements in his projects. I decided then that, as soon as I could find the time, I’d try to recreate this applied research while honoring that same minimalist spirit I fell in love with.

So, here we are: **a naive approach to a volumetric cloud renderer using Vanilla JavaScript and WebGL.** I’m well aware that "baking" this from scratch—without compute shaders, WebGPU, or external dependencies—might seem like over-engineering, but I truly wanted to respect the simplicity I mentioned before.

---

## Architecture Overview

Rendering realistic clouds in real-time is notoriously expensive. A naive approach requires calculating the density of the cloud and the light scattering at thousands of points along a ray for every single pixel on the screen. 

To achieve stable frame rates, we try to split the workload across a multi-pass rendering pipeline:
1. **CPU Baking Pass:** Generates 3D procedural noise on load.
2. **Shadow Pass (Orthographic):** Pre-calculates light penetration.
3. **Raymarching Pass:** Steps through the volume to gather density and light.
4. **TAA Pass (Ping-Pong):** Accumulates frames temporally to smooth out noise.
5. **Display Pass:** Renders the final composite to the screen.

---

## A bit of mathematics

### 1. 3D Procedural Noise (Shape Generation)
Clouds are essentially sculpted noise. Instead of calculating complex noise functions on the GPU for every ray step (which would tank performance), we pre-bake the noise into a `gl.TEXTURE_3D` on the CPU during initialization.

* Inverted Worley Noise: We use Worley (cellular) noise to create the basic "cauliflower" shapes of the clouds; same idea Sebastian showed in his video. By inverting the distance to the nearest scattered points, we can get soft, overlapping spheres (bubbles).
* Fractal Brownian Motion (FBM): Then, we layer multiple "octaves" of this noise. Each subsequent layer has double the frequency (smaller detail) and half the amplitude (less influence). 
* Tileability: To allow the clouds to stretch infinitely across the sky, the noise algorithm wraps the spatial coordinates using modulo arithmetic before calculating distances, ensuring a seamless texture, or at least that's the aim.

### 2. Volumetric Raymarching & AABB
Standard 3D rendering uses polygons. Volumetric rendering uses **Raymarching**. For every pixel, we shoot a ray from the camera into the scene.

To optimize this, we define an **Axis-Aligned Bounding Box (AABB)** (a 3D mathematical container). 
1. So we intersect the camera ray with the AABB.
2. If it misses, we draw the sky.
3. If it hits, we only "step" along the ray *inside* the box, evaluating the 3D noise texture at each step to check for cloud density. Space outside the box is skipped entirely, saving millions of calculations.

### 3. Lighting Physics: The Beer-Lambert Law
When light travels through a cloud, it gets absorbed and scattered by water droplets. The deeper it goes, the darker it gets. This is governed by the **Beer-Lambert Law**:

$$T = e^{-d \cdot \sigma_e}$$

Where:
* $T$ is the Transmittance (how much light survives).
* $d$ is the distance the light traveled through the cloud.
* $\sigma_e$ is the extinction coefficient (how thick/absorbent the cloud is).

At each step inside the cloud, we calculate the transmittance to determine how much light reaches the camera.

### 4. Directional Scattering: Henyey-Greenstein Phase Function
Clouds don't scatter light equally in all directions. When you look towards the sun through a cloud, the edges glow brightly (forward scattering). When you look away from the sun, they look flatter (backward scattering). 

To simulate this mathematically, we use the **Henyey-Greenstein Phase Function**:

$$p(\theta) = \frac{1 - g^2}{4\pi (1 + g^2 - 2g\cos\theta)^{3/2}}$$

Where:
* $\theta$ is the angle between the light ray and the view ray.
* $g$ is the eccentricity (anisotropy) factor between $-1$ and $1$. $g > 0$ means forward scattering, $g < 0$ means backward scattering.
* We blend two lobes (a strong forward lobe and a weak backward lobe) to create realistic silver linings.

### 5. Optimization: Volumetric Shadow Mapping
A naive light-marching approach requires a nested loop: for every step along the view ray, shoot *another* ray towards the sun to calculate how much light reaches that specific spot. If you take 50 view steps and 25 light steps, that's 1250 texture samples *per pixel*. 

So to solve that and to not burn anybody's laptop, we render a pre-pass from the perspective of the Sun using an Orthographic projection. We raymarch the density from the top of the bounding box to the bottom and store the accumulated density in a high-precision 2D texture (`R16F`). 
During the main camera raymarch, instead of stepping towards the sun, we simply do a single texture lookup on this Shadow Map to know exactly how much cloud is between our current point and the sun. This reduces complexity from $\mathcal{O}(N \times M)$ to $\mathcal{O}(N + M)$.

### 6. Temporal Anti-Aliasing (TAA) & Dithering
Raymarching with a low step count (to keep 60fps) creates severe "banding" or "layering" artifacts. 
1. Blue Noise Dithering: We offset the starting position of every ray by a tiny, pseudo-random amount based on a Blue Noise texture. This turns the ugly banding into fine, granular noise.
2. Sub-pixel Jittering (Halton Sequence): We slightly shift the camera matrix every frame using a Halton sequence.
3. Temporal Accumulation: We use Ping-Pong Framebuffers to blend the current frame with the previous frames using an Exponential Moving Average (EMA):
   
$$C_{final} = \alpha \cdot C_{current} + (1 - \alpha) \cdot C_{history}$$

This acts as a temporal blur, magically smoothing out the dithered noise into a soft, high-fidelity volumetric cloud.

---

## Limitations and constraints

While I tried to make this as optimized for browser environments as I could, it's still made with no webGPU nor compute shaders support, so it has multiple mathematical and hardware constraints:

* AABB Clipping: The simulation strictly occurs within a bounding box (12x6x12 units). Clouds will visibly clip if the camera moves outside the optimal viewing bounds or if the noise density expands beyond the borders. It does not simulate planetary curvature or infinite horizons.
* TAA Ghosting (Smearing): Because the Temporal Anti-Aliasing relies heavily on historical frames to smooth out noise, fast camera panning or extremely high wind speeds will cause noticeable ghosting or smearing artifacts.
* Hardware Requirements: This simulation requires full WebGL 2.0 support and relies on floating-point texture extensions (`EXT_color_buffer_float` and `EXT_color_buffer_half_float`) for the Ping-Pong buffers and Shadow Maps. Devices or browsers lacking these extensions will fail to render correctly.
* VRAM Constraints: 3D Textures consume exponentially more VRAM than 2D textures. The baked 64³ and 32³ noise volumes are lightweight enough for modern devices, but scaling the resolution up (e.g., 256³) will quickly exhaust mobile GPU memory.
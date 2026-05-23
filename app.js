/* -------------------------------------------------------------
 * REBREW Cinematic Scrollytelling Engine - Core Logic
 * High-Performance Vanilla JS Canvas Controller
 * ------------------------------------------------------------- */

(function () {
    'use strict';

    // 1. CONFIGURATION & STATE
    const TOTAL_ORIGINAL_FRAMES = 192;
    const FRAME_STEP = 2; // Downsamples sequence to 96 frames for optimal RAM, speed & smooth render
    const MANUAL_BG_COLOR = '#f5f5f2'; // Exact match background token

    // Generate active frames array based on FRAME_STEP (always include final frame)
    const activeFrames = [];
    for (let i = 1; i <= TOTAL_ORIGINAL_FRAMES; i += FRAME_STEP) {
        activeFrames.push(i);
    }
    if (activeFrames[activeFrames.length - 1] !== TOTAL_ORIGINAL_FRAMES) {
        activeFrames.push(TOTAL_ORIGINAL_FRAMES);
    }

    const CRITICAL_LOAD_COUNT = 20; // First 20 active frames load immediately to unblock view
    const criticalFrames = activeFrames.slice(0, CRITICAL_LOAD_COUNT);
    const nonCriticalFrames = activeFrames.slice(CRITICAL_LOAD_COUNT);

    // Cache to hold successfully loaded and decoded HTMLImageElements
    const loadedImages = {};

    // DOM Elements
    const canvas = document.getElementById('scrolly-canvas');
    const ctx = canvas.getContext('2d');
    const preloader = document.getElementById('preloader');
    const preloaderPercent = document.getElementById('preloader-percent');
    const preloaderBar = document.getElementById('preloader-bar');
    const headerNav = document.querySelector('.header-nav');
    const scrollIndicator = document.getElementById('scroll-indicator');
    const storyPanels = document.querySelectorAll('.story-panel');

    // Scroll Physics & Interpolation States
    let targetScrollProgress = 0;
    let currentScrollProgress = 0;
    
    // Adaptive mobile/touch LERP configuration
    const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const LERP_FACTOR = isTouchDevice ? 0.15 : 0.08; // Snappier touch swipe, buttery desktop wheel

    let lastActiveFrameIndex = -1;
    let isInitialRenderComplete = false;

    // Cache sizing variables to prevent layout thrashing (forced reflow) inside requestAnimationFrame loop
    let cachedCanvasWidth = 0;
    let cachedCanvasHeight = 0;

    // Pad file names to match ezgif-frame-XXX.jpg format
    const getFramePath = (idx) => {
        return `Assets/ezgif-frame-${String(idx).padStart(3, '0')}.jpg`;
    };

    // 2. CRITICAL PRELOAD PIPELINE (Sequential & Dynamic Decoding)
    async function initCriticalPreloader() {
        let loadedCount = 0;

        for (const frameId of criticalFrames) {
            try {
                const img = new Image();
                img.src = getFramePath(frameId);
                
                // Triggers asynchronous off-thread GPU decoding prior to resolution
                await new Promise((resolve, reject) => {
                    img.onload = () => resolve();
                    img.onerror = () => reject(new Error(`Failed to load frame ${frameId}`));
                });

                await img.decode();
                loadedImages[frameId] = img;
            } catch (err) {
                console.warn(`Error caching critical frame ${frameId}:`, err);
            } finally {
                loadedCount++;
                updatePreloaderUI(loadedCount, criticalFrames.length);
            }
        }

        // Fades out preloader overlay and starts normal cycles
        completePreloader();
    }

    function updatePreloaderUI(loaded, total) {
        const percent = Math.floor((loaded / total) * 100);
        preloaderPercent.textContent = `${String(percent).padStart(2, '0')}%`;
        preloaderBar.style.width = `${percent}%`;
    }

    function completePreloader() {
        preloader.classList.add('fade-out');
        setTimeout(() => {
            preloader.style.display = 'none';
        }, 1200); // Synchronized with css --transition-buttery

        // Initial setup and draw unblocked
        resizeCanvas();
        triggerInitialFrameDraw();
        
        // Start continuous loop
        requestAnimationFrame(renderLoop);

        // Begin background streaming using browser idle slots
        initProgressiveBackgroundLoader();
    }

    // 3. PROGRESSIVE IDLE BACKGROUND LOADER
    function initProgressiveBackgroundLoader() {
        let currentIndex = 0;
        const idleScheduler = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));

        function loadNextNonCritical() {
            if (currentIndex >= nonCriticalFrames.length) {
                console.log("REBREW Cinematic Sequence: Progressive streaming complete.");
                return;
            }

            const frameId = nonCriticalFrames[currentIndex];

            // Request next idle opportunity from browser main thread
            idleScheduler(async (deadline) => {
                try {
                    const img = new Image();
                    img.src = getFramePath(frameId);

                    await new Promise((resolve) => {
                        img.onload = () => resolve();
                        img.onerror = () => resolve(); // Keep pipeline moving even on failure
                    });

                    // Decode off-thread
                    await img.decode();
                    loadedImages[frameId] = img;
                } catch (err) {
                    // Fail silently, nearest fallback scanner will cover failures
                }

                currentIndex++;
                loadNextNonCritical();
            });
        }

        loadNextNonCritical();
    }

    // 4. NEAREST LOADED FRAME FALLBACK SEARCHER
    function getNearestDecodedFrame(targetId) {
        if (loadedImages[targetId]) return loadedImages[targetId];

        // Search outward in alternate directions to locate nearest completed texture
        const baseIndex = activeFrames.indexOf(targetId);
        let offset = 1;

        while (baseIndex - offset >= 0 || baseIndex + offset < activeFrames.length) {
            // Check previous frame index
            if (baseIndex - offset >= 0) {
                const prevId = activeFrames[baseIndex - offset];
                if (loadedImages[prevId]) return loadedImages[prevId];
            }
            // Check next frame index
            if (baseIndex + offset < activeFrames.length) {
                const nextId = activeFrames[baseIndex + offset];
                if (loadedImages[nextId]) return loadedImages[nextId];
            }
            offset++;
        }

        return null;
    }

    // 5. MATH ENGINE: ASPECT COVER LOGIC (Simulates css 'background-size: cover')
    function renderFrameToCanvas(img) {
        if (!img) return;

        const imgWidth = img.naturalWidth;
        const imgHeight = img.naturalHeight;

        const imgRatio = imgWidth / imgHeight;
        const canvasRatio = cachedCanvasWidth / cachedCanvasHeight;

        let drawWidth, drawHeight, drawX, drawY;

        if (canvasRatio > imgRatio) {
            // Screen is wider than original image aspect ratio
            drawWidth = cachedCanvasWidth;
            drawHeight = cachedCanvasWidth / imgRatio;
            drawX = 0;
            drawY = (cachedCanvasHeight - drawHeight) / 2;
        } else {
            // Screen is taller than original image aspect ratio (portrait / mobile)
            drawWidth = cachedCanvasHeight * imgRatio;
            drawHeight = cachedCanvasHeight;
            drawX = (cachedCanvasWidth - drawWidth) / 2;
            drawY = 0;
        }

        // Draw texture cleared perfectly using manual background hex
        ctx.fillStyle = MANUAL_BG_COLOR;
        ctx.fillRect(0, 0, cachedCanvasWidth, cachedCanvasHeight);
        ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
    }

    // 6. DEBOUNCED RESIZE SYNCHRONIZATION
    let resizeDebounceTimer;
    function resizeCanvas() {
        const rect = canvas.parentNode.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        // Visual layout bounds cache
        cachedCanvasWidth = rect.width * dpr;
        cachedCanvasHeight = rect.height * dpr;

        // Apply visual and pixel dimensions
        canvas.width = cachedCanvasWidth;
        canvas.height = cachedCanvasHeight;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;

        // Scale drawing context by pixel ratio to guarantee Retina crispness
        ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transformations
        
        // Immediate repaint to preserve visual stability
        forceRepaint();
    }

    let lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
        clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = setTimeout(() => {
            const currentWidth = window.innerWidth;
            // Only trigger full layout recalculation if screen width changed (desktop resize or mobile rotation)
            // This blocks minor height adjustments from touch/mobile address bars, eliminating micro-stutters
            if (currentWidth !== lastWidth || !isTouchDevice) {
                lastWidth = currentWidth;
                requestAnimationFrame(resizeCanvas);
            }
        }, 100);
    });

    // 7. SCROLL SYNCHRONIZED INTERPOLATION LOOP
    function updateScrollState() {
        const scrollY = window.scrollY;
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        
        if (maxScroll <= 0) {
            targetScrollProgress = 0;
        } else {
            targetScrollProgress = Math.max(0, Math.min(1, scrollY / maxScroll));
        }

        // Apple-style Glassmorphism Nav Toggle on scroll offset
        if (scrollY > 40) {
            headerNav.classList.add('scrolled');
        } else {
            headerNav.classList.remove('scrolled');
        }

        // Fade scroll prompt line
        if (scrollY > 150) {
            scrollIndicator.style.opacity = '0';
        } else {
            scrollIndicator.style.opacity = '1';
        }
    }

    window.addEventListener('scroll', updateScrollState, { passive: true });

    function renderLoop() {
        // Continuous LERP convergence
        currentScrollProgress += (targetScrollProgress - currentScrollProgress) * LERP_FACTOR;

        // Bound to prevent rounding overflows
        if (Math.abs(targetScrollProgress - currentScrollProgress) < 0.0001) {
            currentScrollProgress = targetScrollProgress;
        }

        // Map float progress smoothly to index keys
        const mappedIndex = Math.min(activeFrames.length - 1, Math.floor(currentScrollProgress * activeFrames.length));
        const targetFrameId = activeFrames[mappedIndex];

        // Renders only when active frame shifts to preserve GPU frame allocations
        if (targetFrameId !== lastActiveFrameIndex || !isInitialRenderComplete) {
            const frameToDraw = getNearestDecodedFrame(targetFrameId);
            if (frameToDraw) {
                renderFrameToCanvas(frameToDraw);
                lastActiveFrameIndex = targetFrameId;
                isInitialRenderComplete = true;
            }
        }

        // Compute scrollytelling copy panels
        orchestrateEditorialText();

        requestAnimationFrame(renderLoop);
    }

    function triggerInitialFrameDraw() {
        const firstFrame = loadedImages[activeFrames[0]];
        if (firstFrame) {
            renderFrameToCanvas(firstFrame);
            lastActiveFrameIndex = activeFrames[0];
        }
    }

    function forceRepaint() {
        if (lastActiveFrameIndex !== -1) {
            const currentImg = getNearestDecodedFrame(lastActiveFrameIndex);
            if (currentImg) {
                renderFrameToCanvas(currentImg);
            }
        }
    }

    // 8. LUXURY MOTION DESIGN: TEXT ORCHESTRATION BEATS
    function orchestrateEditorialText() {
        const pct = currentScrollProgress * 100; // Float percent (0.0 to 100.0)

        storyPanels.forEach((panel) => {
            const start = parseFloat(panel.getAttribute('data-start'));
            const end = parseFloat(panel.getAttribute('data-end'));

            if (pct >= start && pct <= end) {
                panel.classList.add('active');

                // Determine inner boundary range percentage
                const range = end - start;
                const progress = (pct - start) / range; // 0.0 to 1.0

                let opacity = 1;
                let translateY = 0;

                // Subtle Awwwards Parallax: fade-in during first 20%
                if (progress < 0.20) {
                    const factor = progress / 0.20;
                    opacity = factor;
                    translateY = 30 * (1 - factor); // Smooth slide up
                } 
                // Fade-out during final 20%
                else if (progress > 0.80) {
                    const factor = (1 - progress) / 0.20;
                    opacity = factor;
                    translateY = -30 * (1 - factor); // Continue floating up out of viewport
                }

                // Inject computed styles for absolute visual tracking
                panel.style.opacity = opacity;
                panel.style.transform = `translate3d(0, ${translateY}px, 0)`;
                panel.style.pointerEvents = opacity > 0.15 ? 'auto' : 'none';

            } else {
                panel.classList.remove('active');
                panel.style.opacity = '0';
                panel.style.transform = 'translate3d(0, 30px, 0)';
                panel.style.pointerEvents = 'none';
            }
        });
    }

    // Initialize Core Process
    initCriticalPreloader();

})();

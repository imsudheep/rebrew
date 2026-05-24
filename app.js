/* -------------------------------------------------------------
 * REBREW Cinematic Scrollytelling Engine - Core Logic
 * High-Performance Vanilla JS Canvas Controller
 * ------------------------------------------------------------- */

(function () {
    'use strict';

    // 1. CONFIGURATION & STATE
    const START_FRAME = 33;
    const END_FRAME = 240;
    const FRAME_STEP = 1; // Loads all active frames for full density
    const MANUAL_BG_COLOR = '#f5f5f2'; // Exact match background token

    // Generate active frames array based on START_FRAME, END_FRAME, and FRAME_STEP
    const activeFrames = [];
    for (let i = START_FRAME; i <= END_FRAME; i += FRAME_STEP) {
        activeFrames.push(i);
    }
    if (activeFrames[activeFrames.length - 1] !== END_FRAME) {
        activeFrames.push(END_FRAME);
    }

    const CRITICAL_LOAD_COUNT = 208; // Preload all frames for instant scroll response
    const criticalFrames = activeFrames.slice(0, CRITICAL_LOAD_COUNT);

    // Cache to hold successfully loaded and decoded HTMLImageElements
    const loadedImages = {};
    let fallbackCache = {}; // O(1) cache to prevent CPU search bottlenecks inside renderLoop

    // DOM Elements
    const canvas = document.getElementById('scrolly-canvas');
    const ctx = canvas.getContext('2d');

    // High-performance off-screen double-buffering canvas to eliminate GPU texture upload stutters
    const offscreenCanvas = document.createElement('canvas');
    const offscreenCtx = offscreenCanvas.getContext('2d');

    const preloader = document.getElementById('preloader');
    const preloaderPercent = document.getElementById('preloader-percent');
    const preloaderBar = document.getElementById('preloader-bar');
    const preloaderTagline = document.getElementById('preloader-tagline');
    const taglineMessages = [
        "Harvesting the finest grapes...",
        "Cold-pressing the essence...",
        "Aging in stone cellars...",
        "Bottling the experience...",
        "Preparing your tasting..."
    ];
    let taglineIndex = 0;
    const headerNav = document.querySelector('.header-nav');
    const scrollIndicator = document.getElementById('scroll-indicator');
    const storyPanels = document.querySelectorAll('.story-panel');
    const heroContainer = document.getElementById('hero-scrollytelling');

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

    // Pad file names to match ezgif-frame-XXX.jpg format using Vite's absolute BASE_URL prefix
    const getFramePath = (idx) => {
        const base = import.meta.env.BASE_URL || '/';
        return `${base}assets/ezgif-frame-${String(idx).padStart(3, '0')}.jpg`;
    };

    // 2. FULL PRELOAD PIPELINE (All frames loaded during loader)
    async function initCriticalPreloader() {
        document.body.classList.add('loading'); // Force lock screen scroll interactions during preloading
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
                fallbackCache = {}; // Invalidate fallback cache on new load
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

        const msgIndex = Math.min(taglineMessages.length - 1, Math.floor((loaded / total) * taglineMessages.length));
        if (msgIndex !== taglineIndex) {
            taglineIndex = msgIndex;
            preloaderTagline.textContent = taglineMessages[taglineIndex];
        }
    }

    function completePreloader() {
        document.body.classList.remove('loading'); // Unpin scrolling interactions once critical frames are in memory
        preloader.classList.add('fade-out');
        setTimeout(() => {
            preloader.style.display = 'none';
        }, 1200); // Synchronized with css --transition-buttery

        // Initial setup and draw unblocked
        resizeCanvas();
        triggerInitialFrameDraw();
        
        // Start continuous loop
        requestAnimationFrame(renderLoop);

        // Initialize scroll reveal triggers for lower editorial sections
        initScrollReveal();
    }

    // 3. NEAREST LOADED FRAME FALLBACK SEARCHER
    function getNearestDecodedFrame(targetId) {
        if (loadedImages[targetId]) return loadedImages[targetId];
        if (fallbackCache[targetId]) return fallbackCache[targetId];

        // Search outward in alternate directions to locate nearest completed texture
        const baseIndex = activeFrames.indexOf(targetId);
        let offset = 1;

        while (baseIndex - offset >= 0 || baseIndex + offset < activeFrames.length) {
            // Check previous frame index
            if (baseIndex - offset >= 0) {
                const prevId = activeFrames[baseIndex - offset];
                if (loadedImages[prevId]) {
                    fallbackCache[targetId] = loadedImages[prevId];
                    return loadedImages[prevId];
                }
            }
            // Check next frame index
            if (baseIndex + offset < activeFrames.length) {
                const nextId = activeFrames[baseIndex + offset];
                if (loadedImages[nextId]) {
                    fallbackCache[targetId] = loadedImages[nextId];
                    return loadedImages[nextId];
                }
            }
            offset++;
        }

        return null;
    }

    // 4. MATH ENGINE: ASPECT COVER LOGIC (Simulates css 'background-size: cover')
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

        // 1. Draw texture cleared perfectly onto memory-based offscreen canvas
        offscreenCtx.fillStyle = MANUAL_BG_COLOR;
        offscreenCtx.fillRect(0, 0, cachedCanvasWidth, cachedCanvasHeight);
        offscreenCtx.drawImage(img, drawX, drawY, drawWidth, drawHeight);

        // 2. Perform zero-latency blit stamp onto visible display canvas (GPU optimized)
        ctx.drawImage(offscreenCanvas, 0, 0);
    }

    // 5. DEBOUNCED RESIZE SYNCHRONIZATION
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

        // Match memory canvas buffer size with visual dimensions
        offscreenCanvas.width = cachedCanvasWidth;
        offscreenCanvas.height = cachedCanvasHeight;

        // Scale drawing context by pixel ratio to guarantee Retina crispness
        ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transformations
        offscreenCtx.setTransform(1, 0, 0, 1, 0, 0); // Synchronize memory context
        
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

    // 6. SCROLL SYNCHRONIZED INTERPOLATION LOOP
    function updateScrollState() {
        const scrollY = window.scrollY;
        const maxHeroScroll = heroContainer.offsetHeight - window.innerHeight;
        
        if (maxHeroScroll <= 0) {
            targetScrollProgress = 0;
        } else {
            targetScrollProgress = Math.max(0, Math.min(1, scrollY / maxHeroScroll));
        }

        // Apple-style Glassmorphism Nav Toggle on scroll offset
        if (scrollY > 40) {
            headerNav.classList.add('scrolled');
        } else {
            headerNav.classList.remove('scrolled');
        }

        // Show navbar only when past the hero section, hide when back inside it
        if (targetScrollProgress >= 1) {
            headerNav.classList.add('visible');
        } else {
            headerNav.classList.remove('visible');
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

    // 7. LUXURY MOTION DESIGN: TEXT ORCHESTRATION BEATS
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

    // 8. HIGH-PERFORMANCE INTERSECTIONOBSERVER SCROLL-REVEAL ENGINE
    function initScrollReveal() {
        const revealElements = document.querySelectorAll('.reveal-up');
        
        const observerOptions = {
            root: null, // viewport
            rootMargin: '0px 0px -100px 0px', // trigger slightly prior to fully entering screen
            threshold: 0.15 // 15% visibility trigger
        };

        const observer = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('active');
                    observer.unobserve(entry.target); // Unobserve once animated
                }
            });
        }, observerOptions);

        revealElements.forEach(el => observer.observe(el));
    }

    // 9. SMOOTH SCROLL & HAMBURGER MENU
    const hamburger = document.getElementById('hamburger');
    const navMenu = document.getElementById('nav-menu');

    hamburger.addEventListener('click', () => {
        hamburger.classList.toggle('active');
        navMenu.classList.toggle('open');
    });

    function smoothScrollTo(targetId) {
        const target = document.querySelector(targetId);
        if (!target) return;
        const headerOffset = 80;
        const top = target.getBoundingClientRect().top + window.scrollY - headerOffset;
        window.scrollTo({ top, behavior: 'smooth' });
    }

    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const href = link.getAttribute('href');
            smoothScrollTo(href);

            // Close mobile menu after selecting a link
            hamburger.classList.remove('active');
            navMenu.classList.remove('open');
        });
    });

    // Initialize Core Process
    initCriticalPreloader();

})();

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LibAV WASM is a WebAssembly port of FFmpeg's libav libraries that enables video remuxing (primarily MKV -> MP4) directly in the browser. The library provides streaming video playback capabilities with support for seeking, buffering, and thumbnail generation.

## Core Architecture

### Multi-layered Architecture
- **Main Thread (src/index.ts)**: Exposes the public API, manages worker communication, handles abort controllers and queuing
- **Web Worker (src/worker/index.ts)**: Handles WASM module instantiation, video decoding for thumbnails, and provides type-safe interfaces to C++ layer
- **C++ Layer (src/main.cpp)**: FFmpeg bindings for remuxing operations, subtitle extraction, and media parsing
- **Build System**: Docker-based compilation using Emscripten to compile FFmpeg and C++ code to WebAssembly

### Key Components
- **Remuxer**: Core class that handles media format conversion and streaming
- **Worker Communication**: Uses `osra` library for type-safe worker messaging
- **Abort Management**: Queue-based system with abort controllers for cancelling operations
- **Stream Processing**: Chunked reading with configurable buffer sizes for large video files

## Common Development Commands

### Development Workflow
```bash
# Start development server with hot reload
npm run dev

# Individual development commands
npm run dev-wasm-cmd    # Watch C++ files and rebuild WASM
npm run dev-web         # Start Vite dev server on port 1234
npm run worker-build-dev # Watch worker TypeScript files
```

### Build Process
```bash
# Full production build (includes Docker compilation)
npm run build

# Individual build steps
npm run make-docker     # Compile WASM via Docker
npm run vite-build      # Build main library
npm run build-worker    # Build worker
npm run types          # Generate TypeScript declarations
```

### Docker Commands
```bash
# Rebuild WASM module (requires Docker)
npm run make-docker

# Clean Docker setup
npm run docker-clean
```

## Development Setup Requirements

### Prerequisites
- Docker (required for WASM compilation)
- Node.js with npm
- For C++ IntelliSense: Clone FFmpeg and Emscripten repositories in project root

### Docker-based Compilation
The project uses a multi-stage Docker build that:
1. Compiles x264 encoder with Emscripten
2. Configures and builds FFmpeg with specific codecs (H.264, HEVC, AAC)
3. Compiles the C++ wrapper with Emscripten bindings
4. Outputs WASM module and JavaScript glue code to `/dist`

## Key Implementation Details

### Worker Architecture
- Worker runs in separate thread to avoid blocking main thread during WASM operations
- Supports concurrent thumbnail generation using VideoDecoder API and OffscreenCanvas
- Type-safe communication via `osra` with proper error handling

### Memory Management
- Uses ArrayBuffer transfers for efficient data passing between threads
- Implements proper cleanup with abort controllers
- Handles WASM heap growth for large video files

### Stream Processing
- Supports HTTP range requests for streaming large video files
- Implements backpressure handling and buffering strategies
- Provides seeking with keyframe alignment

### Media Features
- Remuxing: MKV/Matroska → MP4 container format
- Codecs: H.264, HEVC video; AAC, AC3, EAC3 audio
- Subtitle extraction and processing
- Chapter and attachment extraction
- Thumbnail generation from keyframes

## File Organization

- `src/index.ts` - Public API and worker management
- `src/worker/index.ts` - Worker thread implementation and WASM interfaces
- `src/main.cpp` - C++ FFmpeg wrapper with Emscripten bindings
- `src/utils.ts` - Stream processing utilities and debouncing functions
- `src/test.ts` - Complete example implementation with MediaSource API
- `build/` - Compiled output directory
- `dist/` - WASM module and package.json for distribution

## Browser Compatibility

- Requires modern browser with WebAssembly support
- Uses MediaSource API for video playback
- VideoDecoder API for thumbnail generation (with fallback handling)
- SharedArrayBuffer not required (uses regular ArrayBuffer transfers)
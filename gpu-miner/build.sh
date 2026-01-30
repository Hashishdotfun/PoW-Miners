#!/bin/bash

# PoW Miner build script

set -e

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              POW MINER - BUILD SCRIPT                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Detect CUDA
HAS_CUDA=0
if command -v nvcc &> /dev/null; then
    echo "✓ CUDA detected"
    nvcc --version | head -1
    HAS_CUDA=1
else
    echo "⚠ CUDA not detected"
fi

# Detect OpenCL
HAS_OPENCL=0
if [ -f "/usr/lib/x86_64-linux-gnu/libOpenCL.so" ] || [ -f "/System/Library/Frameworks/OpenCL.framework/OpenCL" ]; then
    echo "✓ OpenCL detected"
    HAS_OPENCL=1
else
    echo "⚠ OpenCL not detected"
fi

echo ""
echo "📦 Available build options:"
echo "   1) CPU only (default)"
echo "   2) CPU + CUDA"
echo "   3) CPU + OpenCL"
echo "   4) CPU + CUDA + OpenCL (all)"
echo ""

read -p "Choose (1-4) [1]: " choice
choice=${choice:-1}

echo ""
echo "🔨 Building..."
echo ""

# Go back to workspace root
cd ..

case $choice in
    1)
        echo "Building CPU only..."
        cargo build --release -p pow-miner
        ;;
    2)
        if [ $HAS_CUDA -eq 0 ]; then
            echo "❌ CUDA not available, building CPU only..."
            cargo build --release -p pow-miner
        else
            echo "Building with CUDA..."
            # Compile CUDA kernel
            cd miner
            nvcc kernels/sha256_mining.cu \
                --ptx \
                -o kernels/sha256_mining.ptx \
                -O3 \
                --use_fast_math
            cd ..

            cargo build --release -p pow-miner --features cuda
        fi
        ;;
    3)
        if [ $HAS_OPENCL -eq 0 ]; then
            echo "❌ OpenCL not available, building CPU only..."
            cargo build --release -p pow-miner
        else
            echo "Building with OpenCL..."
            cargo build --release -p pow-miner --features opencl
        fi
        ;;
    4)
        FEATURES=""
        if [ $HAS_CUDA -eq 1 ]; then
            FEATURES="cuda"
            cd miner
            nvcc kernels/sha256_mining.cu \
                --ptx \
                -o kernels/sha256_mining.ptx \
                -O3 \
                --use_fast_math
            cd ..
        fi
        if [ $HAS_OPENCL -eq 1 ]; then
            if [ -n "$FEATURES" ]; then
                FEATURES="$FEATURES,opencl"
            else
                FEATURES="opencl"
            fi
        fi

        if [ -n "$FEATURES" ]; then
            echo "Building with: $FEATURES..."
            cargo build --release -p pow-miner --features "$FEATURES"
        else
            echo "Building CPU only (no GPU detected)..."
            cargo build --release -p pow-miner
        fi
        ;;
    *)
        echo "❌ Invalid choice, building CPU only..."
        cargo build --release -p pow-miner
        ;;
esac

echo ""
echo "✅ Build complete!"
echo ""
echo "📍 Binary: target/release/miner"
echo "📍 Benchmark: target/release/benchmark"
echo ""
echo "🚀 Quick test:"
echo "   ./target/release/miner --benchmark"
echo "   ./target/release/benchmark"
echo ""

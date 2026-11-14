#ifndef SILK_WAMR_SHARED_ACCESS_H
#define SILK_WAMR_SHARED_ACCESS_H

#include "wasm_runtime.h"
#include <string.h>

/* Capacity is the immutable physical extent, never a view's visible length.
 * All aliases, including JS views, use the same aligned 8/4/2/1 cells. */
uint64 silk_wamr_shared_capacity(WASMMemoryInstance *memory);
uint32 silk_wamr_shared_wait(WASMMemoryInstance *memory, void *address,
                            uint64 expected, int64 timeout_ns, bool is_i64);
uint32 silk_wamr_shared_notify(WASMMemoryInstance *memory, void *address,
                              uint32 count);

static inline bool
silk_wamr_memory_is_shared(WASMMemoryInstance *memory)
{
#if WASM_ENABLE_SHARED_MEMORY != 0
    return memory->is_shared_memory;
#else
    (void)memory;
    return false;
#endif
}

static inline uint64
silk_wamr_mask(uint32 width)
{
    return width == 8 ? UINT64_MAX : (((uint64)1 << (width * 8)) - 1);
}

static inline uint32
silk_wamr_cell(WASMMemoryInstance *memory, uint64 offset, uint64 *start)
{
    uint64 capacity = silk_wamr_shared_capacity(memory);
    uint32 width = 8;
    *start = offset & ~(uint64)7;
    while (capacity - *start < width) {
        width >>= 1;
        if (offset >= *start + width)
            *start += width;
    }
    return width;
}

static inline uint64
silk_wamr_cell_load(void *address, uint32 width, int order)
{
    switch (width) {
        case 8: return __atomic_load_n((uint64 *)address, order);
        case 4: return __atomic_load_n((uint32 *)address, order);
        case 2: return __atomic_load_n((uint16 *)address, order);
        default: return __atomic_load_n((uint8 *)address, order);
    }
}

static inline bool
silk_wamr_cell_cas(void *address, uint32 width, uint64 *expected,
                   uint64 replacement, int order)
{
    bool result;
    switch (width) {
        case 8:
            return __atomic_compare_exchange_n((uint64 *)address, expected,
                                               replacement, false, order, order);
        case 4: {
            uint32 value = (uint32)*expected;
            result = __atomic_compare_exchange_n((uint32 *)address, &value,
                (uint32)replacement, false, order, order);
            *expected = value;
            return result;
        }
        case 2: {
            uint16 value = (uint16)*expected;
            result = __atomic_compare_exchange_n((uint16 *)address, &value,
                (uint16)replacement, false, order, order);
            *expected = value;
            return result;
        }
        default: {
            uint8 value = (uint8)*expected;
            result = __atomic_compare_exchange_n((uint8 *)address, &value,
                (uint8)replacement, false, order, order);
            *expected = value;
            return result;
        }
    }
}

/* Atomic operations are naturally aligned and fit within one canonical cell.
 * Operation numbers match SilkJS shared_memory.operate. */
static inline uint64
silk_wamr_memory_atomic(WASMMemoryInstance *memory, void *address,
                        uint32 width, uint32 operation, uint64 value,
                        uint64 replacement)
{
    uint64 start, offset = (uint8 *)address - memory->memory_data;
    uint32 cell_width = silk_wamr_memory_is_shared(memory)
        ? silk_wamr_cell(memory, offset, &start) : width;
    uint32 shift;
    uint64 mask = silk_wamr_mask(width), previous, current, next;
    void *cell;
    if (!silk_wamr_memory_is_shared(memory))
        start = offset;
    shift = (uint32)(offset - start) * 8;
    cell = memory->memory_data + start;
    previous = silk_wamr_cell_load(cell, cell_width, __ATOMIC_SEQ_CST);
    for (;;) {
        current = (previous >> shift) & mask;
        switch (operation) {
            case 0: next = current + value; break;
            case 1: next = current & value; break;
            case 2: next = current | value; break;
            case 3: next = current - value; break;
            case 4: next = current ^ value; break;
            case 5: next = value; break;
            case 6:
                if (current != (value & mask))
                    return current;
                next = replacement;
                break;
            default: return current;
        }
        next = (previous & ~(mask << shift)) | ((next & mask) << shift);
        if (silk_wamr_cell_cas(cell, cell_width, &previous, next,
                               __ATOMIC_SEQ_CST))
            return current;
    }
}

static inline void
silk_wamr_memory_read(WASMMemoryInstance *memory, const void *address,
                      void *out, uint64 size)
{
    uint8 *destination = out;
    uint64 offset = (const uint8 *)address - memory->memory_data;
    if (!silk_wamr_memory_is_shared(memory)) {
        memcpy(out, address, (size_t)size);
        return;
    }
    while (size) {
        uint64 start, bits;
        uint32 width = silk_wamr_cell(memory, offset, &start);
        uint32 skip = (uint32)(offset - start), count = width - skip, i;
        if (size < count)
            count = (uint32)size;
        bits = silk_wamr_cell_load(memory->memory_data + start, width,
                                   __ATOMIC_RELAXED) >> (skip * 8);
        for (i = 0; i < count; i++) {
            *destination++ = (uint8)bits;
            bits >>= 8;
        }
        size -= count;
        offset += count;
    }
}

static inline void
silk_wamr_memory_write(WASMMemoryInstance *memory, void *address,
                       const void *in, uint64 size)
{
    const uint8 *source = in;
    uint64 offset = (uint8 *)address - memory->memory_data;
    if (!silk_wamr_memory_is_shared(memory)) {
        memcpy(address, in, (size_t)size);
        return;
    }
    while (size) {
        uint64 start, bits = 0, mask, previous, next;
        uint32 width = silk_wamr_cell(memory, offset, &start);
        uint32 skip = (uint32)(offset - start), count = width - skip, i;
        void *cell = memory->memory_data + start;
        if (size < count)
            count = (uint32)size;
        for (i = 0; i < count; i++)
            bits |= (uint64)*source++ << (i * 8);
        mask = silk_wamr_mask(count) << (skip * 8);
        previous = silk_wamr_cell_load(cell, width, __ATOMIC_RELAXED);
        do {
            next = (previous & ~mask) | (bits << (skip * 8));
        } while (!silk_wamr_cell_cas(cell, width, &previous, next,
                                     __ATOMIC_RELAXED));
        size -= count;
        offset += count;
    }
}

static inline uint64
silk_wamr_memory_load(WASMMemoryInstance *memory, void *address, uint32 width)
{
    uint64 value = 0, offset;
    uint32 shift = 0;
    if (!silk_wamr_memory_is_shared(memory)) {
        uint32 i;
        for (i = 0; i < width; i++)
            value |= (uint64)((uint8 *)address)[i] << (i * 8);
        return value;
    }
    offset = (uint8 *)address - memory->memory_data;
    while (width) {
        uint64 start, bits;
        uint32 cell_width = silk_wamr_cell(memory, offset, &start);
        uint32 skip = (uint32)(offset - start);
        uint32 count = cell_width - skip;
        if (count > width)
            count = width;
        bits = silk_wamr_cell_load(memory->memory_data + start, cell_width,
                                   __ATOMIC_RELAXED);
        value |= ((bits >> (skip * 8)) & silk_wamr_mask(count)) << shift;
        shift += count * 8;
        offset += count;
        width -= count;
    }
    return value;
}

static inline void
silk_wamr_memory_store(WASMMemoryInstance *memory, void *address,
                       uint32 width, uint64 value)
{
    uint64 offset;
    if (!silk_wamr_memory_is_shared(memory)) {
        uint32 i;
        for (i = 0; i < width; i++)
            ((uint8 *)address)[i] = (uint8)(value >> (i * 8));
        return;
    }
    offset = (uint8 *)address - memory->memory_data;
    while (width) {
        uint64 start, mask, previous, next;
        uint32 cell_width = silk_wamr_cell(memory, offset, &start);
        uint32 skip = (uint32)(offset - start), count = cell_width - skip;
        void *cell = memory->memory_data + start;
        if (count > width)
            count = width;
        mask = silk_wamr_mask(count) << (skip * 8);
        previous = silk_wamr_cell_load(cell, cell_width, __ATOMIC_RELAXED);
        do {
            next = (previous & ~mask) | ((value << (skip * 8)) & mask);
        } while (!silk_wamr_cell_cas(cell, cell_width, &previous, next,
                                     __ATOMIC_RELAXED));
        if (count != 8)
            value >>= count * 8;
        offset += count;
        width -= count;
    }
}

static inline void
silk_wamr_memory_copy(WASMMemoryInstance *memory, void *destination,
                      const void *source, uint64 size)
{
    uint8 *dst = destination;
    const uint8 *src = source;
    uint64 value;
    uint32 count;
    if (!silk_wamr_memory_is_shared(memory)) {
        memmove(destination, source, (size_t)size);
        return;
    }
    if (dst > src && (uint64)(dst - src) < size) {
        while (size) {
            count = size > 8 ? 8 : (uint32)size;
            size -= count;
            value = silk_wamr_memory_load(memory, (void *)(src + size), count);
            silk_wamr_memory_store(memory, dst + size, count, value);
        }
    }
    else {
        while (size) {
            count = size > 8 ? 8 : (uint32)size;
            value = silk_wamr_memory_load(memory, (void *)src, count);
            silk_wamr_memory_store(memory, dst, count, value);
            src += count;
            dst += count;
            size -= count;
        }
    }
}

static inline void
silk_wamr_memory_fill(WASMMemoryInstance *memory, void *destination,
                      uint8 value, uint64 size)
{
    uint8 *dst = destination;
    if (!silk_wamr_memory_is_shared(memory)) {
        memset(destination, value, (size_t)size);
        return;
    }
    while (size) {
        uint32 count = size > 8 ? 8 : (uint32)size;
        silk_wamr_memory_store(memory, dst, count,
                               (uint64)value * UINT64_C(0x0101010101010101));
        dst += count;
        size -= count;
    }
}
#endif

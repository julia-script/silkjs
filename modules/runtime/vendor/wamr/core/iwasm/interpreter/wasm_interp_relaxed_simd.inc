/* SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
 * Deterministic permitted choices for relaxed SIMD: strict swizzle/truncation,
 * non-fused multiply-add, bitwise lane selection, strict min/max and signed
 * eight-bit interpretation of the relaxed dot-product's second input.
 */
                    case SIMD_i8x16_relaxed_swizzle:
                        SIMD_DOUBLE_OP(simde_wasm_i8x16_swizzle);
                        break;
                    case SIMD_i32x4_relaxed_trunc_f32x4_s:
                        SIMD_SINGLE_OP(simde_wasm_i32x4_trunc_sat_f32x4);
                        break;
                    case SIMD_i32x4_relaxed_trunc_f32x4_u:
                        SIMD_SINGLE_OP(simde_wasm_u32x4_trunc_sat_f32x4);
                        break;
                    case SIMD_i32x4_relaxed_trunc_f64x2_s_zero:
                        SIMD_SINGLE_OP(simde_wasm_i32x4_trunc_sat_f64x2_zero);
                        break;
                    case SIMD_i32x4_relaxed_trunc_f64x2_u_zero:
                        SIMD_SINGLE_OP(simde_wasm_u32x4_trunc_sat_f64x2_zero);
                        break;
                    case SIMD_f32x4_relaxed_min:
                        SIMD_DOUBLE_OP(simde_wasm_f32x4_min);
                        break;
                    case SIMD_f32x4_relaxed_max:
                        SIMD_DOUBLE_OP(simde_wasm_f32x4_max);
                        break;
                    case SIMD_f64x2_relaxed_min:
                        SIMD_DOUBLE_OP(simde_wasm_f64x2_min);
                        break;
                    case SIMD_f64x2_relaxed_max:
                        SIMD_DOUBLE_OP(simde_wasm_f64x2_max);
                        break;
                    case SIMD_i16x8_relaxed_q15mulr_s:
                        SIMD_DOUBLE_OP(simde_wasm_i16x8_q15mulr_sat);
                        break;
                    case SIMD_f32x4_relaxed_madd:
                    case SIMD_f32x4_relaxed_nmadd:
                    case SIMD_f64x2_relaxed_madd:
                    case SIMD_f64x2_relaxed_nmadd:
                    {
                        V128 c = POP_V128(), b = POP_V128(), a = POP_V128();
                        simde_v128_t av = SIMD_V128_TO_SIMDE_V128(a);
                        simde_v128_t bv = SIMD_V128_TO_SIMDE_V128(b);
                        simde_v128_t cv = SIMD_V128_TO_SIMDE_V128(c), rv;
                        if (simd_opcode <= SIMD_f32x4_relaxed_nmadd) {
                            rv = simde_wasm_f32x4_mul(av, bv);
                            if (simd_opcode == SIMD_f32x4_relaxed_nmadd)
                                rv = simde_wasm_f32x4_neg(rv);
                            rv = simde_wasm_f32x4_add(rv, cv);
                        }
                        else {
                            rv = simde_wasm_f64x2_mul(av, bv);
                            if (simd_opcode == SIMD_f64x2_relaxed_nmadd)
                                rv = simde_wasm_f64x2_neg(rv);
                            rv = simde_wasm_f64x2_add(rv, cv);
                        }
                        V128 result;
                        SIMDE_V128_TO_SIMD_V128(rv, result);
                        PUSH_V128(result);
                        break;
                    }
                    case SIMD_i8x16_relaxed_laneselect:
                    case SIMD_i16x8_relaxed_laneselect:
                    case SIMD_i32x4_relaxed_laneselect:
                    case SIMD_i64x2_relaxed_laneselect:
                    {
                        V128 mask = POP_V128(), b = POP_V128(), a = POP_V128();
                        simde_v128_t rv = simde_wasm_v128_bitselect(
                            SIMD_V128_TO_SIMDE_V128(a),
                            SIMD_V128_TO_SIMDE_V128(b),
                            SIMD_V128_TO_SIMDE_V128(mask));
                        V128 result;
                        SIMDE_V128_TO_SIMD_V128(rv, result);
                        PUSH_V128(result);
                        break;
                    }
                    case SIMD_i16x8_relaxed_dot_i8x16_i7x16_s:
                    case SIMD_i32x4_relaxed_dot_i8x16_i7x16_add_s:
                    {
                        V128 result, accumulator = { 0 };
                        bool add = simd_opcode
                            == SIMD_i32x4_relaxed_dot_i8x16_i7x16_add_s;
                        if (add)
                            accumulator = POP_V128();
                        V128 b = POP_V128(), a = POP_V128();
                        uint32 lane;
                        if (add) {
                            for (lane = 0; lane < 4; lane++) {
                                uint32 bits = (uint32)accumulator.i32x4[lane];
                                uint32 j;
                                for (j = 0; j < 4; j++)
                                    bits += (uint32)((int32)a.i8x16[4 * lane + j]
                                                     * b.i8x16[4 * lane + j]);
                                memcpy(&result.i32x4[lane], &bits, 4);
                            }
                        }
                        else {
                            for (lane = 0; lane < 8; lane++) {
                                uint16 bits = (uint16)(
                                    (int32)a.i8x16[2 * lane] * b.i8x16[2 * lane]
                                    + (int32)a.i8x16[2 * lane + 1]
                                          * b.i8x16[2 * lane + 1]);
                                memcpy(&result.i16x8[lane], &bits, 2);
                            }
                        }
                        PUSH_V128(result);
                        break;
                    }

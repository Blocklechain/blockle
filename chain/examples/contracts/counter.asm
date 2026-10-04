; counter.asm — a persistent counter.
; Call with an 8-byte LE amount in calldata to add it; empty calldata adds 1.
; Returns the new counter value (8 bytes LE).
    PUSH 0
    PUSH 0
    CALLDATASIZE
    CALLDATACOPY        ; mem[0..] = calldata
    PUSH 0
    MLOAD64             ; increment (0 when no calldata)
    DUP 0
    ISZERO
    PUSH @useone
    JUMPI
    PUSH @doadd
    JUMP
useone:
    POP
    PUSH 1
doadd:
    PUSH 64             ; storage key: 32 zero bytes at mem[64]
    PUSH 32             ; load current value to mem[32]
    SLOAD
    POP
    PUSH 32
    MLOAD64             ; old value
    ADD
    PUSH 32
    SWAP 1
    MSTORE64            ; mem[32] = new value
    PUSH 64
    PUSH 32
    PUSH 8
    SSTORE
    PUSH 32
    PUSH 8
    RETURN

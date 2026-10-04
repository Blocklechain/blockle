; faucet.asm — hold deposits, pay out 1 BLOCK per request.
; Call with value attached and EMPTY calldata to deposit.
; Call with ANY calldata to receive 1 BLOCK (traps if the faucet is dry,
; which refunds any attached value).
    CALLDATASIZE
    PUSH @withdraw
    JUMPI
    STOP                ; deposit: keep the attached value
withdraw:
    PUSH 0
    CALLER              ; mem[0..32] = caller address
    PUSH 0
    PUSH 100000000      ; 1 BLOCK
    SEND
    STOP

# .zsh fixture for the shuck LSP smoke (#3968).
#
# Vectors generated from the real `shuck` binary at the pinned provenance
# `ewhauser/shuck@21e04198463a54be70aa7826acc4dcdbe7996b2b` (v0.2.3, MIT),
# never invented: line 2's `local` at file scope and line 3's zsh-only
# `local -A` are exactly what a bash-semantic analyzer misreports, while
# line 4's reference-before-assignment is the real zsh defect shuck reports
# (C006, error severity — the seeded finding the nightly gate looks for).
zparseopts -D -E -F -- a=opts
local -A counts
counts[answer]=42
echo $undefined_var
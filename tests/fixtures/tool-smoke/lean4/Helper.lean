def helperVal : Nat := 42

theorem helper_thm (n : Nat) : n + 0 = n := by
  rfl

@[extern "lean_smoke_add"]
opaque smokeAdd (a b : Nat) : Nat

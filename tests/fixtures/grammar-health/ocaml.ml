type shape =
  | Circle of float
  | Rect of float * float

let area = function
  | Circle r -> 3.14159 *. r *. r
  | Rect (w, h) -> w *. h

module Counter = struct
  type t = { mutable count : int }

  let create () = { count = 0 }
  let incr c = c.count <- c.count + 1
end

let rec sum = function
  | [] -> 0.0
  | x :: rest -> x +. sum rest

let () =
  let shapes = [ Circle 1.0; Rect (2.0, 3.0) ] in
  let total = List.map area shapes |> sum in
  Printf.printf "%.2f\n" total

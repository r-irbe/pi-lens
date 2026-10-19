import Foundation

protocol Shape {
    func area() -> Double
}

struct Rect: Shape {
    let width: Double
    let height: Double

    func area() -> Double { width * height }
}

enum Outcome {
    case ok(Int)
    case failure(String)
}

func total(_ shapes: [Shape]) -> Double {
    var sum = 0.0
    for shape in shapes {
        sum += shape.area()
    }
    return sum
}

let outcome: Outcome = .ok(3)
switch outcome {
case .ok(let value) where value > 1:
    print("big \(value)")
case .ok, .failure:
    print("other")
}
guard let first = [Rect(width: 1, height: 2)].first else { fatalError() }
print(total([first]))

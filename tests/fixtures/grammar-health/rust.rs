use std::collections::HashMap;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
enum Shape {
    Circle(f64),
    Rect { w: f64, h: f64 },
}

impl Shape {
    fn area(&self) -> f64 {
        match self {
            Shape::Circle(r) => 3.14159 * r * r,
            Shape::Rect { w, h } => w * h,
        }
    }
}

impl fmt::Display for Shape {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self)
    }
}

fn largest<'a, T: PartialOrd>(items: &'a [T]) -> Option<&'a T> {
    items.iter().fold(None, |best, item| match best {
        Some(b) if b >= item => Some(b),
        _ => Some(item),
    })
}

fn main() {
    let shapes = vec![Shape::Circle(1.0), Shape::Rect { w: 2.0, h: 3.0 }];
    let mut seen: HashMap<String, f64> = HashMap::new();
    for shape in &shapes {
        seen.insert(shape.to_string(), shape.area());
    }
    println!("{:?} {}", largest(&[1, 3, 2]), seen.len());
}

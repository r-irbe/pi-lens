import 'dart:async';

abstract class Shape {
  double area();
}

class Circle extends Shape {
  final double radius;
  Circle(this.radius);

  @override
  double area() => 3.14159 * radius * radius;
}

mixin Logger {
  void log(String message) => print('[log] $message');
}

Future<int> total(List<Shape> shapes) async {
  var sum = 0.0;
  for (final shape in shapes) {
    sum += shape.area();
  }
  await Future<void>.delayed(const Duration(milliseconds: 1));
  return sum.round();
}

void main() async {
  final shapes = <Shape>[Circle(1), Circle(2)];
  print(await total(shapes));
}

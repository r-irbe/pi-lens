const std = @import("std");

const Shape = union(enum) {
    circle: f64,
    rect: struct { w: f64, h: f64 },

    fn area(self: Shape) f64 {
        return switch (self) {
            .circle => |r| 3.14159 * r * r,
            .rect => |r| r.w * r.h,
        };
    }
};

fn total(shapes: []const Shape) f64 {
    var sum: f64 = 0;
    for (shapes) |shape| {
        sum += shape.area();
    }
    return sum;
}

pub fn main() !void {
    const shapes = [_]Shape{ .{ .circle = 1.0 }, .{ .rect = .{ .w = 2.0, .h = 3.0 } } };
    const stdout = std.io.getStdOut().writer();
    try stdout.print("{d}\n", .{total(&shapes)});
}

using System;
using System.Collections.Generic;
using System.Linq;

namespace Corpus
{
    public record Point(int X, int Y);

    public interface IShape
    {
        double Area();
    }

    public sealed class Square : IShape
    {
        private readonly double _side;

        public Square(double side) => _side = side;

        public double Area() => _side * _side;
    }

    public static class Program
    {
        public static async Task<int> Main(string[] args)
        {
            var shapes = new List<IShape> { new Square(2), new Square(3) };
            var total = shapes.Select(s => s.Area()).Sum();
            try
            {
                Console.WriteLine($"total={total:F1}");
            }
            catch (Exception ex) when (ex is IOException)
            {
                return 1;
            }
            return await Task.FromResult(0);
        }
    }
}

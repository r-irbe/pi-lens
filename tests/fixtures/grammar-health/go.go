package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

type Shape interface {
	Area() float64
}

type Rect struct{ W, H float64 }

func (r Rect) Area() float64 { return r.W * r.H }

func total[T Shape](shapes []T) float64 {
	var sum float64
	for _, s := range shapes {
		sum += s.Area()
	}
	return sum
}

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var wg sync.WaitGroup
	results := make(chan float64, 2)
	for i := 1; i <= 2; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			results <- total([]Rect{{float64(n), 2}})
		}(i)
	}
	wg.Wait()
	close(results)
	select {
	case <-ctx.Done():
		fmt.Println(errors.New("cancelled"))
	default:
		for r := range results {
			fmt.Println(r)
		}
	}
}
